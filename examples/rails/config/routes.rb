Rails.application.routes.draw do
  root "docs#index"

  # One form, two buttons: #signup and #signin submit here with intent=signup|signin.
  resource :session, only: %i[create destroy]

  resources :docs, only: %i[show create update]

  get "up" => "rails/health#show", as: :rails_health_check
end
