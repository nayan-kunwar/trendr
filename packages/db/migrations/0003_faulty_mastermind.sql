CREATE INDEX "auth_tokens_family_idx" ON "auth_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "alerts_user_idx" ON "alerts" USING btree ("user_id");