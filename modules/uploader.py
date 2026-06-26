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


def _load_creds_from_firestore() -> Credentials | None:
    """Load YouTube OAuth credentials from Firestore. Returns None if
    the stored token can't be parsed or Firestore isn't configured."""
    try:
        from backend import db
        if not db.is_configured():
            return None
        snap = db.client().collection("api_keys").document("YOUTUBE_REFRESH_TOKEN").get()
        if not snap.exists:
            return None
        d = snap.to_dict() or {}
        raw = d.get("value")
        if not raw:
            return None
        # The stored value is the full credentials JSON (token + refresh_token + client_id + ...).
        import json as _json
        info = _json.loads(raw) if isinstance(raw, str) else raw
        return Credentials.from_authorized_user_info(info, SCOPES)
    except Exception as e:
        log.warning(f"uploader: Firestore creds load failed: {e}")
        return None


def _save_creds_to_firestore(creds: Credentials) -> bool:
    """Persist YouTube OAuth credentials to Firestore so all backends share them."""
    try:
        from backend import db
        if not db.is_configured():
            return False
        db.client().collection("api_keys").document("YOUTUBE_REFRESH_TOKEN").set({
            "value": creds.to_json(),
            "updated_at": db.server_timestamp(),
        })
        return True
    except Exception as e:
        log.warning(f"uploader: Firestore creds save failed: {e}")
        return False


def get_youtube_client():
    """Get a YouTube API client. Resolution order:
        1. Firestore api_keys/YOUTUBE_REFRESH_TOKEN (production source of truth)
        2. Local TOKEN_FILE (dev fallback)
        3. Run the local-server OAuth flow (dev only — won't work on Colab/HF)
    """
    creds = _load_creds_from_firestore()
    source = "firestore"

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
            # Persist the refreshed token back to whichever store we
            # loaded from (and Firestore if available — that's where
            # other workers will look next time).
            _save_creds_to_firestore(creds)
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


def _resumable_upload(request, max_retries=5):
    """Drive a resumable upload, retrying transient errors."""
    response = None
    retry_n = 0
    while response is None:
        try:
            status, response = request.next_chunk()
            if status:
                log.info(f"Upload progress: {int(status.progress() * 100)}%")
        except HttpError as e:
            # 5xx + 403 rateLimit/quota → retry.
            if e.resp.status in (500, 502, 503, 504) and retry_n < max_retries:
                retry_n += 1
                sleep = 2 ** retry_n
                log.warning(f"Upload chunk error {e.resp.status}; retry {retry_n}/{max_retries} in {sleep}s")
                time.sleep(sleep)
                continue
            raise
    return response


def upload_video(video_path, script_data, channel_type="horror"):
    """
    Upload video to YouTube; return video ID on success, None on failure.
    Also generates and uploads a thumbnail (best-effort).
    """
    if not os.path.exists(video_path):
        log.error(f"Video file not found: {video_path}")
        return None

    youtube = get_youtube_client()

    s = load_settings()
    up = s.get("upload", {})
    privacy = (up.get("privacy") or config.PRIVACY or "private").lower()
    if privacy not in ("public", "unlisted", "private"):
        privacy = "private"
    made_for_kids = bool(up.get("made_for_kids", False))
    category_id = up.get(f"category_{channel_type}") or CATEGORY_IDS.get(channel_type, "24")

    title = (script_data.get("youtube_title") or "Untitled")[:100]
    description = (script_data.get("description") or "")[:5000]
    tags = (script_data.get("tags") or [])[:500]

    body = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags,
            "categoryId": category_id,
            "defaultLanguage": "en",
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

    # Notify Discord (best-effort, never fails the upload).
    try:
        from backend import notifier
        notifier.info(
            f"📺 Published to YouTube · {channel_type}",
            body=f"`{script_data.get('youtube_title', '(no title)')[:120]}`",
            url=f"https://youtu.be/{video_id}",
            fields=[("video_id", video_id, True), ("channel", channel_type, True)],
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
