<?php

namespace App\Http\Controllers;

use App\Services\Cheapabase;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use RuntimeException;

class AuthController extends Controller
{
    public function __construct(private Cheapabase $cheapabase) {}

    public function signUp(Request $request): RedirectResponse
    {
        return $this->attempt($request, fn ($email, $password) => $this->cheapabase->signUp($email, $password));
    }

    public function signIn(Request $request): RedirectResponse
    {
        return $this->attempt($request, fn ($email, $password) => $this->cheapabase->signIn($email, $password));
    }

    public function signOut(): RedirectResponse
    {
        $this->cheapabase->signOut();

        return redirect('/');
    }

    private function attempt(Request $request, callable $action): RedirectResponse
    {
        $request->session()->regenerate();

        try {
            $action((string) $request->input('email'), (string) $request->input('password'));
        } catch (RuntimeException $e) {
            return back()->withInput($request->only('email'))->with('error', $e->getMessage());
        }

        return redirect('/');
    }
}
