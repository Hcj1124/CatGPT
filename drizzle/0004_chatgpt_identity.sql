ALTER TABLE users ADD COLUMN chatgpt_user_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_chatgpt_user_id
ON users(chatgpt_user_id)
WHERE chatgpt_user_id IS NOT NULL;
