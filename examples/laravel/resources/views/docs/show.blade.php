@extends('layout')

@section('title', $doc['title'] ?? 'Not found')

@section('content')
  <p><a href="/">&larr; All docs</a></p>

  @if (! $doc)
    <p id="not-found">This doc doesn't exist, or you don't have access to it.</p>
  @else
    <h1 id="doc-title">{{ $doc['title'] }}</h1>

    <form method="POST" action="{{ route('docs.update', $doc['id']) }}">
      @csrf
      @method('PATCH')
      <textarea id="content" name="content">{{ $doc['content'] }}</textarea>
      <button id="save" type="submit">Save</button>
      <span id="status" class="muted">{{ session('status') }}</span>
    </form>

    {{-- Live updates: the browser talks to cheapabase realtime directly with the user's own JWT. --}}
    <script type="module">
      import { RealtimeClient } from "{{ $cheapabaseUrl }}/realtime.js";

      const content = document.getElementById("content");
      const status = document.getElementById("status");
      let saved = content.value;

      const rt = new RealtimeClient(@json($cheapabaseUrl), () => @json($accessToken));
      await rt.on("docs", { event: "UPDATE", filter: @json('id=eq.'.$doc['id']) }, ({ new: doc }) => {
        if (content.value !== saved) return; // don't clobber unsaved edits
        content.value = saved = doc.content;
        status.textContent = "Updated elsewhere";
      });
    </script>
  @endif
@endsection
