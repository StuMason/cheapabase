@extends('layout')

@section('content')
  <header>
    <h1>cheapabase <span>docs</span></h1>
    <form method="POST" action="{{ route('signout') }}" style="margin: 0">
      @csrf
      <button id="signout" type="submit" class="secondary">Sign out</button>
    </form>
  </header>

  {{-- The message comes from the "hello" function, called with this user's token. --}}
  <p id="hello">{{ $hello }}</p>

  <form method="POST" action="{{ route('docs.store') }}">
    @csrf
    <input id="new-doc-title" name="title" placeholder="New doc title">
    <button id="create-doc" type="submit">Create</button>
  </form>

  <ul>
    @forelse ($docs as $doc)
      <li><a class="doc-link" href="{{ route('docs.show', $doc['id']) }}">{{ $doc['title'] }}</a></li>
    @empty
      <li class="muted">No docs yet.</li>
    @endforelse
  </ul>
@endsection
