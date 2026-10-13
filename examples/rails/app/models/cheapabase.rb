require "net/http"

# A tiny cheapabase (Supabase-compatible) client built on Net::HTTP.
#
#   Cheapabase.sign_in(email, password)          # => session hash (access_token, refresh_token, ...)
#   db = Cheapabase.new(access_token)
#   db.rest(:get, "docs?select=id,title")        # PostgREST, as the user (RLS applies)
#   db.function("hello")                         # /functions/v1/hello
class Cheapabase
  class Error < StandardError
    attr_reader :status

    def initialize(message, status)
      super(message)
      @status = status
    end
  end

  def self.url
    ENV.fetch("CHEAPABASE_URL", "http://localhost:8000").chomp("/")
  end

  # The anon key isn't configured anywhere: the gateway publishes it.
  def self.anon_key
    @anon_key ||= JSON.parse(Net::HTTP.get(URI("#{url}/config.json"))).fetch("anonKey")
  end

  # --- auth (GoTrue at /auth/v1) ---

  def self.sign_up(email, password)
    new(nil).request(:post, "/auth/v1/signup", { email:, password: })
  end

  def self.sign_in(email, password)
    new(nil).request(:post, "/auth/v1/token?grant_type=password", { email:, password: })
  end

  def self.refresh(refresh_token)
    new(nil).request(:post, "/auth/v1/token?grant_type=refresh_token", { refresh_token: })
  end

  def initialize(access_token)
    @access_token = access_token
  end

  def sign_out
    request(:post, "/auth/v1/logout")
  rescue Error
    nil # the local session is cleared either way
  end

  # --- data ---

  # PostgREST at /rest/v1. path is e.g. "docs?id=eq.123".
  def rest(method, path, body = nil, headers = {})
    request(method, "/rest/v1/#{path}", body, headers)
  end

  def function(name, method = :get, body = nil)
    request(method, "/functions/v1/#{name}", body)
  end

  def request(method, path, body = nil, headers = {})
    uri = URI("#{self.class.url}#{path}")
    req = Net::HTTPGenericRequest.new(method.to_s.upcase, !body.nil?, true, uri.request_uri)
    req["apikey"] = self.class.anon_key
    req["Authorization"] = "Bearer #{@access_token || self.class.anon_key}"
    req["Accept"] = "application/json"
    headers.each { |k, v| req[k] = v }
    if body
      req["Content-Type"] = "application/json"
      req.body = body.to_json
    end

    res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https",
                          open_timeout: 5, read_timeout: 15) { |http| http.request(req) }
    data = res.body.present? ? JSON.parse(res.body) : nil
    return data if res.is_a?(Net::HTTPSuccess)

    message = data.is_a?(Hash) && (data["msg"] || data["message"] || data["error_description"] || data["error"])
    raise Error.new(message || "#{res.code} #{res.message}", res.code.to_i)
  rescue JSON::ParserError
    raise Error.new("#{res.code} #{res.message}", res.code.to_i)
  end
end
