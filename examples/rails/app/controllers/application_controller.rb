class ApplicationController < ActionController::Base
  # The session cookie holds the cheapabase session: access token, refresh token, email.
  helper_method :signed_in?, :current_email, :access_token

  # A 401 from cheapabase means the session is no longer valid: start over.
  rescue_from Cheapabase::Error do |e|
    raise e unless e.status == 401
    reset_session
    redirect_to root_path, alert: "Your session expired, please sign in again."
  end

  private

  def signed_in? = access_token.present?
  def current_email = session[:email]

  # The user's access token, refreshed with the refresh token when it's (about to be) expired.
  def access_token
    return @access_token if defined?(@access_token)
    return @access_token = nil if session[:access_token].blank?

    if session[:expires_at].to_i < 30.seconds.from_now.to_i
      begin
        store_session(Cheapabase.refresh(session[:refresh_token]))
      rescue Cheapabase::Error
        reset_session
        return @access_token = nil
      end
    end
    @access_token = session[:access_token]
  end

  def store_session(auth)
    session[:access_token] = auth["access_token"]
    session[:refresh_token] = auth["refresh_token"]
    session[:expires_at] = auth["expires_at"] || Time.now.to_i + auth["expires_in"].to_i
    session[:email] = auth.dig("user", "email") || session[:email]
    @access_token = auth["access_token"]
  end

  def cheapabase = Cheapabase.new(access_token)

  def require_sign_in
    redirect_to root_path unless signed_in?
  end
end
