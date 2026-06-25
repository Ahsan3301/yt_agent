"""
researcher.py — Content Research Module

Horror: generates an original story premise by combining a random setting +
        hook (no Reddit, no network dependency at all). scriptwriter.py then
        has Gemini expand that premise into a full nosleep-style narration.
        Used combos are tracked in data/used_premises.json so you don't get
        the same premise twice until the whole pool has been used.

Wisdom: trending topics via pytrends / RSS (unchanged from before).
"""

import os
import json
import random
import logging
import feedparser
from pytrends.request import TrendReq
from dotenv import load_dotenv

from modules.config import load_settings

load_dotenv()
log = logging.getLogger(__name__)

USED_PREMISES_FILE = "data/used_premises.json"

HORROR_SETTINGS = [
    "an abandoned summer camp deep in the woods",
    "a 24-hour gas station off a remote highway",
    "a college dorm during finals week",
    "a rural farmhouse inherited from a relative",
    "an apartment building where one neighbor has never been seen",
    "a hiking trail that was officially closed years ago",
    "a hospital during the overnight shift",
    "a small town with only one road in and out",
    "a last-minute Airbnb booking in an unfamiliar city",
    "a basement that isn't on the house's original blueprints",
    "a long-haul overnight bus route",
    "an old elevator in a building that's mostly empty after 6pm",
    "a childhood home revisited after years away",
    "a campsite at a lake with a local legend attached to it",
    "a babysitting job in an unfamiliar neighborhood",
]

HORROR_HOOKS = [
    "a knocking sound that happens at the exact same time every night",
    "a figure in the distance that mimics every move you make",
    "text messages arriving from your own phone number",
    "a door that locks itself from the inside",
    "the same stranger appearing in the background of every photo taken that day",
    "a voice on the phone that sounds exactly like someone who already died",
    "footsteps that match yours, one step behind, even when you stop",
    "a neighbor who insists they've met you before, somewhere you've never been",
    "an object that keeps returning to the same spot no matter how many times it's thrown away",
    "a video call that keeps cutting back to a frame of someone standing perfectly still, watching",
    "a smell that only appears right before something happens",
    "a reflection that takes a half-second too long to copy your movement",
    "handwriting in a journal that isn't yours, describing your day before it happens",
    "a power outage that only ever affects one specific room",
    "a song playing faintly from somewhere with no speakers nearby",
]


def _load_used():
    if not os.path.exists(USED_PREMISES_FILE):
        return set()
    try:
        with open(USED_PREMISES_FILE, "r") as f:
            return set(json.load(f))
    except (json.JSONDecodeError, OSError) as e:
        log.warning(f"used_premises.json unreadable ({e}); starting fresh")
        return set()


def _save_used(combo_id):
    """Atomic write: temp file + replace, so a crash mid-write can't corrupt state."""
    used = _load_used()
    used.add(combo_id)
    os.makedirs(os.path.dirname(USED_PREMISES_FILE), exist_ok=True)
    tmp = USED_PREMISES_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(list(used), f)
    os.replace(tmp, USED_PREMISES_FILE)


def generate_horror_premise():
    """
    Combines a random setting + hook into a short premise string for
    scriptwriter.py to expand into a full original story. Cycles through
    all combinations before repeating any of them.
    """
    used = _load_used()
    all_combos = [(s, h) for s in HORROR_SETTINGS for h in HORROR_HOOKS]
    unused = [c for c in all_combos if f"{c[0]}|{c[1]}" not in used]

    if not unused:
        log.info("All horror premise combinations used — resetting pool")
        unused = all_combos

    setting, hook = random.choice(unused)
    _save_used(f"{setting}|{hook}")

    return f"Someone experiences {hook}, while at {setting}."


def get_trending_topics():
    """
    Get trending topics from Google Trends for the wisdom niche.
    Returns list of topic strings.
    """
    try:
        pt = TrendReq(hl="en-US", tz=360)
        trending_df = pt.trending_searches(pn="united_states")
        topics = trending_df[0].tolist()[:10]
        log.info(f"Got {len(topics)} trending topics")
        return topics
    except Exception as e:
        log.warning(f"Pytrends failed: {e}")
        return []


def get_rss_topics(feeds=None):
    """
    Pull recent headlines from RSS feeds.
    Returns list of topic strings.
    """
    if feeds is None:
        feeds = [
            "https://feeds.feedburner.com/TechCrunch",
            "https://rss.cnn.com/rss/edition.rss",
        ]
    topics = []
    for url in feeds:
        try:
            parsed = feedparser.parse(url)
            for entry in parsed.entries[:5]:
                topics.append(entry.get("title", ""))
        except Exception as e:
            log.warning(f"RSS feed failed ({url}): {e}")
    return [t for t in topics if t]


def research(channel_type="horror"):
    """
    Main entry point. Returns a content dict ready for the script writer.
    channel_type: "horror" | "wisdom"

    If settings.content.manual_premise is set, it overrides the auto-generated
    premise (so users can run a specific story idea from the GUI).
    """
    manual = (load_settings().get("content") or {}).get("manual_premise", "").strip()
    if manual:
        log.info(f"Using manual premise from settings: {manual[:80]}")
        return {
            "type": channel_type,
            "raw_title": manual,
            "raw_body": "",
            "source_url": "",
            "keywords": [channel_type, "manual override"],
        }

    if channel_type == "horror":
        premise = generate_horror_premise()
        return {
            "type": "horror",
            "raw_title": premise,
            "raw_body": "",
            "source_url": "",
            "keywords": ["horror", "scary story", "creepy", "true horror"],
        }

    elif channel_type == "wisdom":
        topics = get_trending_topics() or get_rss_topics()
        if not topics:
            topics = ["life lessons", "mindset", "productivity"]
        return {
            "type": "wisdom",
            "raw_title": topics[0],
            "raw_body": "",
            "source_url": "",
            "keywords": topics[:5],
        }

    return None