<?php

namespace App\Http\Controllers;

use App\Services\Cheapabase;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

class DocController extends Controller
{
    public function __construct(private Cheapabase $cheapabase) {}

    /** Sign-in form when signed out, otherwise the hello message and the user's docs. */
    public function index(): View
    {
        if (! $user = $this->cheapabase->user()) {
            return view('signin');
        }

        return view('docs.index', [
            'user' => $user,
            'hello' => $this->cheapabase->function('hello')->json('message'),
            // RLS only returns docs this user owns or was shared.
            'docs' => $this->cheapabase->rest()
                ->get('/docs', ['select' => 'id,title', 'order' => 'updated_at.desc'])
                ->throw()
                ->json(),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        $doc = $this->cheapabase->rest()
            ->withHeaders(['Prefer' => 'return=representation'])
            ->post('/docs', ['title' => $request->input('title') ?: 'Untitled'])
            ->throw()
            ->json(0);

        return redirect()->route('docs.show', $doc['id']);
    }

    public function show(string $id): View
    {
        $response = $this->cheapabase->rest()->get('/docs', ['id' => "eq.$id", 'select' => '*']);

        // A malformed id is a 400 from PostgREST; a doc RLS hides is just an empty list.
        $doc = $response->successful() ? $response->json(0) : null;

        return view('docs.show', [
            'doc' => $doc,
            'cheapabaseUrl' => $this->cheapabase->url(),
            'accessToken' => $this->cheapabase->accessToken(),
        ]);
    }

    public function update(Request $request, string $id): RedirectResponse
    {
        $this->cheapabase->rest()
            ->patch("/docs?id=eq.$id", ['content' => (string) $request->input('content')])
            ->throw();

        return redirect()->route('docs.show', $id)->with('status', 'Saved');
    }
}
