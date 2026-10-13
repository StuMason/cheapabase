<?php

namespace App\Http\Middleware;

use App\Services\Cheapabase;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Signed-out visitors (or ones whose refresh token stopped working) go back to the sign-in form. */
class SignedIn
{
    public function __construct(private Cheapabase $cheapabase) {}

    public function handle(Request $request, Closure $next): Response
    {
        if (! $this->cheapabase->accessToken()) {
            return redirect('/');
        }

        return $next($request);
    }
}
