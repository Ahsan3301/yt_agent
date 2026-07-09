"""
uploader.py — YouTube Upload Module
Uses YouTube Data API v3 (free) to upload the final video.

FIRST-TIME SETUP:
1. Go to https://console.cloud.google.com
2. Create a project → enable YouTube Data API v3
3. Create OAuth 2.0 credentials (Desktop App)
4. Download client_secret.json → put in config/
5. Run this script once manually to complete OAuth browser flow
   It saves a token to config/youtube_token.json for future runs.

Privacy controlled by YOUTUBE_PRIVACY env var (public|unlisted|private).
"""
import os
import time
import logging
from pathlib import Path
from dotenv import load_dotenv

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from googleapiclient.errors import HttpError

from modules import config
from modules.config import load_settings
from modules.thumbnail import generate_thumbnail


def _repair_mojibake(s: str) -> str:
    """Best-effort UTF-8-decoded-as-Latin-1 repair.

    Detects the classic pattern where a UTF-8-encoded string was
    accidentally decoded as Latin-1 (e.g. '•' rendered as 'â\x80¢' or
    the display artefact 'â ¢'). Round-trips: encode as Latin-1 → decode
    as UTF-8. If that raises, return the original string unchanged.

    Called on title / description / tags right before we hand them to
    the YouTube API. Belt-and-braces alongside the NIM stream charset
    fix — this catches corruption from ANY source (legacy runs, cached
    checkpoints, other providers) not just NIM.
    """
    if not isinstance(s, str) or not s:
        return s
    # Cheap check: mojibake tokens for common punctuation. If none of
    # them appear, skip the (expensive-ish) round-trip.
    _MARKERS = ("â\x80", "Ã©", "Ã¨", "Ã¡", "Â ", "Â·", "â€", "â¢", "â\x80\x99")
    if not any(m in s for m in _MARKERS):
        return s
    try:
        repaired = s.encode("latin-1", errors="strict").decode("utf-8", errors="strict")
        return repaired
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s

load_dotenv()
log = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
]
CLIENT_SECRETS = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secret.json")
TOKEN_FILE = os.getenv("YOUTUBE_TOKEN_FILE", "config/youtube_token.json")

CATEGORY_IDS = {
    "horror": "24",   # Entertainment
    "wisdom": "27",   # Education
}


def _load_creds_from_firestore(account_id: str | None = None) -> Credentials | None:
    """Load YouTube OAuth credentials from Firestore.

    Resolution order:
      1. If `account_id` is given → youtube_accounts/<account_id>.credentials
      2. Otherwise → legacy api_keys/YOUTUBE_REFRESH_TOKEN.value

    Returns None if the stored token can't be parsed or Firestore
    isn't configured.
    """
    try:
        from backend import db
        if not db.is_configured():
            return None
        import json as _json

        # Per-account lookup (multi-channel mode).
        if account_id:
            snap = db.client().collection("youtube_accounts").document(account_id).get()
            if not snap.exists:
                log.warning(f"uploader: youtube_accounts/{account_id} missing")
                return None
            d = snap.to_dict() or {}
            raw = d.get("credentials") or d.get("value")
            if not raw:
                return None
            info = _json.loads(raw) if isinstance(raw, str) else raw
            return Credentials.from_authorized_user_info(info, SCOPES)

        # Legacy single-doc fallback.
        snap = db.client().collection("api_keys").document("YOUTUBE_REFRESH_TOKEN").get()
        if not snap.exists:
            return None
        d = snap.to_dict() or {}
        raw = d.get("value")
        if not raw:
            return None
        info = _json.loads(raw) if isinstance(raw, str) else raw
        return Credentials.from_authorized_user_info(info, SCOPES)
    except Exception as e:
        log.warning(f"uploader: Firestore creds load failed: {e}")
        return None


def _save_creds_to_firestore(creds: Credentials, account_id: str | None = None) -> bool:
    """Persist refreshed credentials. When `account_id` is given, writes
    to youtube_accounts/<id>.credentials so the per-account doc stays
    current; otherwise updates the legacy single-doc location."""
    try:
        from backend import db
        if not db.is_configured():
            return False
        if account_id:
            db.client().collection("youtube_accounts").document(account_id).set({
                "credentials": creds.to_json(),
                "updated_at": db.server_timestamp(),
            }, merge=True)
            return True
        db.client().collection("api_keys").document("YOUTUBE_REFRESH_TOKEN").set({
            "value": creds.to_json(),
            "updated_at": db.server_timestamp(),
        })
        return True
    except Exception as e:
        log.warning(f"uploader: Firestore creds save failed: {e}")
        return False


def get_youtube_client(account_id: str | None = None):
    """Get a YouTube API client. Resolution order:
        1. Firestore api_keys/YOUTUBE_REFRESH_TOKEN (production source of truth)
        2. Local TOKEN_FILE (dev fallback)
        3. Run the local-server OAuth flow (dev only — won't work on Colab/HF)
    """
    creds = _load_creds_from_firestore(account_id=account_id)
    source = f"firestore:{account_id or 'legacy'}"

    if not creds and os.path.exists(TOKEN_FILE):
        try:
            creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
            source = "local file"
        except Exception as e:
            log.warning(f"uploader: local token file unreadable: {e}")

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            log.info(f"Refreshing YouTube token (from {source})...")
            creds.refresh(Request())
            # Persist refreshed token back to the same slot we loaded
            # from (per-account doc OR legacy single doc).
            _save_creds_to_firestore(creds, account_id=account_id)
        else:
            # Interactive OAuth — only works on a machine with a browser.
            # On Colab/HF Space this is impossible; the user must complete
            # OAuth once via the dashboard (web/app/api/youtube/auth + callback).
            if not os.path.exists(CLIENT_SECRETS):
                raise FileNotFoundError(
                    f"client_secret.json not found at {CLIENT_SECRETS}, and no "
                    "refresh token in Firestore.\nVisit the dashboard's Settings "
                    "page → 'Connect YouTube' to complete the one-time OAuth flow."
                )
            log.info("Opening browser for YouTube OAuth2 login...")
            flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRETS, SCOPES)
            creds = flow.run_local_server(port=0)
            # New creds → save everywhere.
            Path(TOKEN_FILE).parent.mkdir(parents=True, exist_ok=True)
            with open(TOKEN_FILE, "w") as f:
                f.write(creds.to_json())
            _save_creds_to_firestore(creds)
            log.info(f"Token saved to {TOKEN_FILE} and Firestore")

    return build("youtube", "v3", credentials=creds)


_RETRIABLE_HTTP = (408, 429, 500, 502, 503, 504)
# 403 reasons that YouTube documents as transient — DIFFERENT from
# 'quotaExceeded' which is a hard daily-quota fail and should not retry.
_RETRIABLE_403_REASONS = {
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "backendError",
    "internalError",
}


def _is_retriable_httperror(e) -> tuple[bool, str]:
    """Classify a googleapiclient HttpError. Returns (retriable, reason)."""
    status = getattr(e.resp, "status", None)
    if status in _RETRIABLE_HTTP:
        return True, f"HTTP {status}"
    if status == 403:
        # Body carries {"error":{"errors":[{"reason":"..."}]}}
        try:
            import json as _json
            body = _json.loads(e.content.decode("utf-8", "replace")) if e.content else {}
            errors = (body.get("error") or {}).get("errors") or []
            reason = (errors[0].get("reason") if errors else "") or ""
            if reason in _RETRIABLE_403_REASONS:
                return True, f"403 {reason}"
        except Exception:
            pass
    return False, f"HTTP {status}"


def _is_retriable_network(e) -> bool:
    """Classify a non-HttpError as transient network trouble."""
    import socket
    import ssl
    import http.client
    return isinstance(e, (
        socket.timeout, socket.error,
        ssl.SSLError,
        http.client.IncompleteRead, http.client.RemoteDisconnected,
        ConnectionError, TimeoutError,
    ))


def _resumable_upload(request, max_retries=8):
    """Drive a resumable upload, retrying transient errors.

    Retries on:
      - HTTP 408, 429, 500, 502, 503, 504
      - HTTP 403 with reason in {rateLimitExceeded, userRateLimitExceeded,
        backendError, internalError}
      - Socket / SSL / IncompleteRead / RemoteDisconnected / generic
        ConnectionError / TimeoutError

    Everything else raises. Exponential backoff with jitter, capped at 60 s
    per attempt so a rate-limited upload can eventually succeed instead of
    burning the retry budget in the first 30 seconds.
    """
    import random as _random
    response = None
    retry_n = 0
    while response is None:
        try:
            status, response = request.next_chunk()
            if status:
                log.info(f"Upload progress: {int(status.progress() * 100)}%")
        except HttpError as e:
            retriable, reason = _is_retriable_httperror(e)
            if not retriable or retry_n >= max_retries:
                log.error(f"Upload chunk error {reason}; giving up after {retry_n} retries")
                raise
            retry_n += 1
            base = min(60, 2 ** retry_n)
            sleep = base + _random.uniform(0, 2)
            log.warning(f"Upload chunk error {reason}; retry {retry_n}/{max_retries} in {sleep:.1f}s")
            time.sleep(sleep)
        except Exception as e:
            if not _is_retriable_network(e) or retry_n >= max_retries:
                log.error(f"Upload chunk fatal ({type(e).__name__}: {e}); no retry")
                raise
            retry_n += 1
            base = min(60, 2 ** retry_n)
            sleep = base + _random.uniform(0, 2)
            log.warning(
                f"Upload chunk network error ({type(e).__name__}: {e}); "
                f"retry {retry_n}/{max_retries} in {sleep:.1f}s"
            )
            time.sleep(sleep)
    return response


def upload_video(video_path, script_data, channel_type="horror", youtube_account_id=None, language=None):
    """
    Upload video to YouTube; return video ID on success, None on failure.
    Also generates and uploads a thumbnail (best-effort).

    `youtube_account_id`: per-channel YouTube account id. When None, the
    uploader falls back to the legacy single-doc credential. With
    multi-account support each dashboard channel can target a different
    YouTube channel.

    `language`: BCP-47 code (en/de/hi/es/fr/...) written into the video's
    `defaultLanguage` + `defaultAudioLanguage` fields so YouTube treats
    the title/description in the right script and enables auto-translate
    for viewers in other locales. Falls back to script_data['language']
    then 'en'.
    """
    if not os.path.exists(video_path):
        log.error(f"Video file not found: {video_path}")
        return None

    youtube = get_youtube_client(account_id=youtube_account_id)
    if youtube_account_id:
        log.info(f"Uploading via YouTube account {youtube_account_id}")

    s = load_settings()
    up = s.get("upload", {})
    privacy = (up.get("privacy") or config.PRIVACY or "private").lower()
    if privacy not in ("public", "unlisted", "private"):
        privacy = "private"
    made_for_kids = bool(up.get("made_for_kids", False))
    category_id = up.get(f"category_{channel_type}") or CATEGORY_IDS.get(channel_type, "24")

    title = _repair_mojibake((script_data.get("youtube_title") or "Untitled"))[:100]
    description = _repair_mojibake((script_data.get("description") or ""))[:5000]
    tags = [_repair_mojibake(t) for t in (script_data.get("tags") or [])[:500]]

    eff_lang = (
        (language or script_data.get("language") or "en") or "en"
    ).lower()[:2]
    body = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags,
            "categoryId": category_id,
            # BCP-47: 'en' is fine, so is 'de', 'hi', 'ja'. Matters for
            # YouTube search + auto-translate; wrong value hides non-EN
            # videos from their intended audience.
            "defaultLanguage": eff_lang,
            "defaultAudioLanguage": eff_lang,
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": made_for_kids,
        },
    }

    media = MediaFileUpload(
        video_path,
        mimetype="video/mp4",
        resumable=True,
        chunksize=1024 * 1024 * 5,
    )

    log.info(f"Uploading '{title}' as {privacy}...")
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)

    try:
        response = _resumable_upload(request)
    except Exception as e:
        log.error(f"Upload failed: {e}")
        return None

    video_id = response.get("id")
    if not video_id:
        log.error(f"Upload returned no id: {response}")
        return None

    log.info(f"Upload complete! https://youtu.be/{video_id}")

    # Notify Discord (best-effort, never fails the upload). Resolve the
    # YouTube account's display title from PB so operators can see which
    # channel got the video without opening YouTube Studio.
    try:
        from backend import notifier
        acct_label = ""
        if youtube_account_id:
            try:
                from backend import db as _db
                if _db.is_configured():
                    ydoc = _db.client().collection("youtube_accounts").document(youtube_account_id).get()
                    if ydoc.exists:
                        acct_label = str((ydoc.to_dict() or {}).get("title") or "")
            except Exception:
                pass
        fields = [("video_id", video_id, True), ("channel", channel_type, True)]
        if acct_label:
            fields.append(("youtube_account", acct_label, True))
        elif youtube_account_id:
            fields.append(("youtube_account_id", youtube_account_id, True))
        notifier.info(
            f"📺 Published to YouTube · {channel_type}",
            body=(
                f"`{script_data.get('youtube_title', '(no title)')[:120]}`\n"
                f"https://youtu.be/{video_id}"
            ),
            url=f"https://youtu.be/{video_id}",
            fields=fields,
        )
    except Exception as _e:
        log.debug(f"notifier on upload skipped: {_e}")

    # ── Thumbnail (best effort; never fails the upload) ──
    try:
        thumb_path = os.path.join(os.path.dirname(video_path), "thumbnail.jpg")
        if generate_thumbnail(video_path, title, thumb_path):
            log.info("Uploading thumbnail...")
            youtube.thumbnails().set(
                videoId=video_id,
                media_body=MediaFileUpload(thumb_path, mimetype="image/jpeg"),
            ).execute()
            log.info("Thumbnail attached.")
    except HttpError as e:
        # Common cause: account not yet verified for custom thumbnails.
        log.warning(f"Thumbnail upload skipped: {e}")
    except Exception as e:
        log.warning(f"Thumbnail step failed: {e}")

    return video_id
