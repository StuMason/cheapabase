@extends('layout')

@section('content')
  <h1>cheapabase <span>docs</span></h1>
  <p class="muted">Laravel talking to cheapabase over HTTP. Sign up with any email, no confirmation needed.</p>

  <form method="POST" action="{{ route('signin') }}" style="flex-direction: column">
    @csrf
    <input id="email" name="email" type="email" placeholder="Email" value="{{ old('email') }}" required autocomplete="email">
    <input id="password" name="password" type="password" placeholder="Password" required minlength="6" autocomplete="current-password">
    <div style="display: flex; gap: 8px">
      <button id="signin" type="submit">Sign in</button>
      <button id="signup" type="submit" class="secondary" formaction="{{ route('signup') }}">Sign up</button>
    </div>
  </form>
  <p id="error" class="error">{{ session('error') }}</p>
@endsection
