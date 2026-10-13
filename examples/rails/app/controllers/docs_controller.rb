class DocsController < ApplicationController
  before_action :require_sign_in, except: :index

  def index
    return render :sign_in unless signed_in?

    @hello = cheapabase.function("hello")["message"]
    @docs = cheapabase.rest(:get, "docs?select=id,title&order=updated_at.desc")
  end

  def show
    @doc = find_doc or render :not_found, status: :not_found
  end

  def create
    doc = cheapabase.rest(:post, "docs", { title: params[:title].presence || "Untitled" },
                          "Prefer" => "return=representation").first
    redirect_to doc_path(doc["id"])
  end

  def update
    rows = cheapabase.rest(:patch, "docs?id=eq.#{doc_id}", { content: params[:content].to_s },
                           "Prefer" => "return=representation")
    return render :not_found, status: :not_found if rows.empty?

    redirect_to doc_path(doc_id), notice: "Saved"
  end

  private

  # RLS decides what the user can see: a doc that isn't theirs simply returns no rows.
  def find_doc
    cheapabase.rest(:get, "docs?id=eq.#{doc_id}&select=id,title,content").first
  end

  def doc_id = params[:id].to_s[/\A[0-9a-f-]{36}\z/] || "00000000-0000-0000-0000-000000000000"
end
