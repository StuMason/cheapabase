import json
import os
from pathlib import Path

from fastapi import FastAPI, Form, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from postgrest.exceptions import APIError
from starlette.middleware.sessions import SessionMiddleware
from supabase_auth.errors import AuthError

from .cheapabase import CHEAPABASE_URL, new_client, remember, user_client

app = FastAPI()
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ.get("SESSION_SECRET", "dev-only-insecure-secret-change-me"),
    same_site="lax",
)
templates = Jinja2Templates(directory=Path(__file__).parent / "templates")


def home(error: str | None = None, request: Request | None = None) -> RedirectResponse:
    if error and request is not None:
        request.session["error"] = error
    return RedirectResponse("/", status_code=303)


@app.get("/")
async def index(request: Request):
    client = await user_client(request)
    if client is None:
        error = request.session.pop("error", None)
        return templates.TemplateResponse(request, "signin.html", {"error": error})

    hello = await client.functions.invoke("hello", {"method": "GET"})
    docs = await client.table("docs").select("id,title").order("updated_at", desc=True).execute()
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "email": request.session.get("email"),
            "hello": json.loads(hello)["message"],
            "docs": docs.data,
            "error": request.session.pop("error", None),
        },
    )


async def start_session(request: Request, auth_call) -> RedirectResponse:
    try:
        res = await auth_call
    except AuthError as e:
        return home(e.message, request)
    if not res.session:
        return home("Check your email to confirm your account.", request)
    remember(request, res.session)
    return home()


@app.post("/signup")
async def sign_up(request: Request, email: str = Form(), password: str = Form()):
    client = await new_client()
    return await start_session(request, client.auth.sign_up({"email": email, "password": password}))


@app.post("/signin")
async def sign_in(request: Request, email: str = Form(), password: str = Form()):
    client = await new_client()
    creds = {"email": email, "password": password}
    return await start_session(request, client.auth.sign_in_with_password(creds))


@app.post("/signout")
async def sign_out(request: Request):
    request.session.clear()
    return home()


@app.post("/docs")
async def create_doc(request: Request, title: str = Form("")):
    client = await user_client(request)
    if client is None:
        return home()
    res = await client.table("docs").insert({"title": title.strip() or "Untitled"}).execute()
    return RedirectResponse(f"/docs/{res.data[0]['id']}", status_code=303)


@app.get("/docs/{doc_id}")
async def show_doc(request: Request, doc_id: str, saved: bool = False):
    client = await user_client(request)
    if client is None:
        return home()
    try:
        res = await client.table("docs").select("id,title,content").eq("id", doc_id).execute()
        doc = res.data[0] if res.data else None
    except APIError:  # e.g. not a valid uuid
        doc = None
    return templates.TemplateResponse(
        request,
        "doc.html",
        {
            "doc": doc,
            "saved": saved,
            "cheapabase_url": CHEAPABASE_URL,
            "access_token": request.session["access_token"],
        },
        status_code=200 if doc else 404,
    )


@app.post("/docs/{doc_id}")
async def save_doc(request: Request, doc_id: str, content: str = Form("")):
    client = await user_client(request)
    if client is None:
        return home()
    await client.table("docs").update({"content": content}).eq("id", doc_id).execute()
    return RedirectResponse(f"/docs/{doc_id}?saved=1", status_code=303)
