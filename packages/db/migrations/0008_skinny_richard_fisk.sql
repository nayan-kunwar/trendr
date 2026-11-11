CREATE TYPE "public"."oauth_provider_t" AS ENUM('google', 'github');--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "oauth_provider_t" NOT NULL,
	"provider_account_id" text NOT NULL,
	"provider_email" "citext",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "oauth_accounts_provider_account_uq" UNIQUE("provider","provider_account_id"),
	CONSTRAINT "oauth_accounts_user_provider_uq" UNIQUE("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;