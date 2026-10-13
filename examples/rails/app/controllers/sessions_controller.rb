class SessionsController < ApplicationController
  # POST /session  (intent=signup or intent=signin)
  def create
    email, password = params.values_at(:email, :password)
    auth = params[:intent] == "signup" ? Cheapabase.sign_up(email, password) : Cheapabase.sign_in(email, password)

    if auth["access_token"].blank?
      redirect_to root_path, alert: "Check your email to confirm your account, then sign in."
    else
      reset_session
      store_session(auth)
      redirect_to root_path
    end
  rescue Cheapabase::Error => e
    redirect_to root_path, alert: e.message
  end

  # DELETE /session
  def destroy
    cheapabase.sign_out if signed_in?
    reset_session
    redirect_to root_path
  end
end
