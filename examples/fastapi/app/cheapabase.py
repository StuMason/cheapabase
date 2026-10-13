"""Per-request supabase-py clients pointed at cheapabase."""

import os
from functools import cache

import httpx
from starlette.requests import Request
from supabase import AsyncClient, AsyncClientOptions, acreate_client
from supabase_auth.errors import AuthError

CHEAPABASE_URL = os.environ.get("CHEAPABASE_URL", "http://localhost:8000").rstrip("/")


@cache
def anon_key() -> str:
    """cheapabase publishes its anon key, so nothing has to be configured."""
    return httpx.get(f"{CHEAPABASE_URL}/config.json").raise_for_status().json()["anonKey"]


async def new_client() -> AsyncClient:
    # Server side: one short-lived client per request, no background refresh timer.
    options = AsyncClientOptions(auto_refresh_token=False, persist_session=False)
    return await acreate_client(CHEAPABASE_URL, anon_key(), options)


def remember(request: Request, session) -> None:
    request.session.update(
        access_token=session.access_token,
        refresh_token=session.refresh_token,
        email=session.user.email if session.user else request.session.get("email"),
    )


async def user_client(request: Request) -> AsyncClient | None:
    """A client acting as the signed-in user, or None when signed out.

    set_session() refreshes the access token with the refresh token if it has
    expired; the (possibly new) tokens are written back to the session cookie.
    """
    access, refresh = request.session.get("access_token"), request.session.get("refresh_token")
    if not access or not refresh:
        return None
    client = await new_client()
    try:
        res = await client.auth.set_session(access, refresh)
    except AuthError:
        res = None
    if not res or not res.session:
        request.session.clear()  # refresh token is no good: sign out
        return None
    remember(request, res.session)
    return client
