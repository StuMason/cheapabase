<?php

use App\Http\Controllers\AuthController;
use App\Http\Controllers\DocController;
use App\Http\Middleware\SignedIn;
use Illuminate\Support\Facades\Route;

Route::get('/', [DocController::class, 'index']);

Route::post('/signup', [AuthController::class, 'signUp'])->name('signup');
Route::post('/signin', [AuthController::class, 'signIn'])->name('signin');
Route::post('/signout', [AuthController::class, 'signOut'])->name('signout');

Route::middleware(SignedIn::class)->group(function () {
    Route::post('/docs', [DocController::class, 'store'])->name('docs.store');
    Route::get('/docs/{id}', [DocController::class, 'show'])->name('docs.show');
    Route::patch('/docs/{id}', [DocController::class, 'update'])->name('docs.update');
});
