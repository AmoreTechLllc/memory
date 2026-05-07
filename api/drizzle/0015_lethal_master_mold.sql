ALTER TABLE "chat_messages" ADD COLUMN "object_uri" text;--> statement-breakpoint
CREATE UNIQUE INDEX "bookmarks_user_at_uri_unique_idx" ON "bookmarks" USING btree ("user_id","at_uri") WHERE "bookmarks"."at_uri" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bookmarks_user_object_uri_unique_idx" ON "bookmarks" USING btree ("user_id","object_uri") WHERE "bookmarks"."object_uri" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_object_uri_unique_idx" ON "chat_messages" USING btree ("object_uri") WHERE "chat_messages"."object_uri" IS NOT NULL;