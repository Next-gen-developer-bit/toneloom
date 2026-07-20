-- ============================================================
-- EchoWrite + ContextOS — Complete Supabase Database Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ╔══════════════════════════════════════════════════════════╗
-- ║  1. EXTENSIONS                                          ║
-- ╚══════════════════════════════════════════════════════════╝

-- Enable pgvector for semantic memory recall (embedding similarity search)
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Enable pg_trgm for fast text search fallbacks
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  2. PROFILES (extends Supabase auth.users)              ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE public.profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT,
  full_name     TEXT,
  avatar_url    TEXT,
  plan          TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team')),

  -- Usage counters (reset monthly via cron or webhook)
  rewrites_used     INT NOT NULL DEFAULT 0,
  summarizes_used   INT NOT NULL DEFAULT 0,
  expands_used      INT NOT NULL DEFAULT 0,
  memories_count    INT NOT NULL DEFAULT 0,

  -- Stripe
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  subscription_status   TEXT DEFAULT 'inactive',
  current_period_end    TIMESTAMPTZ,

  -- Preferences
  default_tone          TEXT DEFAULT 'professional',
  default_llm           TEXT DEFAULT 'gpt-4o',
  auto_inject_context   BOOLEAN DEFAULT true,
  show_floating_toolbar BOOLEAN DEFAULT true,

  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Auto-create a profile when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''),
    COALESCE(NEW.raw_user_meta_data->>'avatar_url', NEW.raw_user_meta_data->>'picture', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();


-- ╔══════════════════════════════════════════════════════════╗
-- ║  3. MEMORIES (ContextOS long-term memory)               ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE public.memories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  source_platform TEXT NOT NULL DEFAULT 'unknown',  -- gmail, notion, chatgpt, claude, gemini, manual, migration
  tags            TEXT[] DEFAULT '{}',
  
  -- pgvector embedding (OpenAI text-embedding-3-small = 1536 dimensions)
  embedding       vector(1536),
  
  -- Predictive retention scoring
  importance_score  FLOAT DEFAULT 0.5,     -- 0.0 to 1.0, decays over time
  access_count      INT DEFAULT 0,          -- how many times recalled
  last_accessed_at  TIMESTAMPTZ,

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Index for fast vector similarity search (IVFFlat for good balance of speed/accuracy)
CREATE INDEX idx_memories_embedding ON public.memories
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Index for user lookups
CREATE INDEX idx_memories_user_id ON public.memories(user_id);
CREATE INDEX idx_memories_user_created ON public.memories(user_id, created_at DESC);

-- Index for tag searches
CREATE INDEX idx_memories_tags ON public.memories USING gin(tags);

-- Auto-increment memory count on profile
CREATE OR REPLACE FUNCTION public.update_memory_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.profiles SET memories_count = memories_count + 1, updated_at = now() WHERE id = NEW.user_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.profiles SET memories_count = GREATEST(memories_count - 1, 0), updated_at = now() WHERE id = OLD.user_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_memory_change
  AFTER INSERT OR DELETE ON public.memories
  FOR EACH ROW
  EXECUTE FUNCTION public.update_memory_count();


-- ╔══════════════════════════════════════════════════════════╗
-- ║  4. TONE PROFILES (Style Blueprints)                    ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE public.tone_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT 'Default',
  is_active       BOOLEAN DEFAULT false,
  samples_count   INT DEFAULT 0,

  -- Style Blueprint — generated from aggregating tone samples
  blueprint       JSONB DEFAULT '{}'::jsonb,
  /*
    Blueprint structure:
    {
      "tone": "professional",
      "formality": "high",
      "avg_sentence_length": 18,
      "vocabulary_level": "advanced",
      "key_phrases": ["I'd like to", "please note", "as discussed"],
      "punctuation_style": "oxford_comma",
      "emoji_usage": "none",
      "paragraph_length": "medium",
      "voice": "active",
      "confidence_score": 0.82
    }
  */

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tone_profiles_user ON public.tone_profiles(user_id);


-- ╔══════════════════════════════════════════════════════════╗
-- ║  5. TONE SAMPLES (raw text used to learn tone)          ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE public.tone_samples (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      UUID NOT NULL REFERENCES public.tone_profiles(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  source_platform TEXT DEFAULT 'unknown',

  -- Extracted features from this sample
  features        JSONB DEFAULT '{}'::jsonb,
  /*
    Features structure:
    {
      "word_count": 142,
      "sentence_count": 8,
      "avg_sentence_length": 17.75,
      "vocabulary_richness": 0.72,
      "formality_score": 0.85,
      "tone_labels": ["professional", "direct"],
      "key_phrases": ["please find attached", "best regards"]
    }
  */

  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tone_samples_profile ON public.tone_samples(profile_id);

-- Auto-increment sample count on tone profile
CREATE OR REPLACE FUNCTION public.update_sample_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.tone_profiles SET samples_count = samples_count + 1, updated_at = now() WHERE id = NEW.profile_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.tone_profiles SET samples_count = GREATEST(samples_count - 1, 0), updated_at = now() WHERE id = OLD.profile_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_tone_sample_change
  AFTER INSERT OR DELETE ON public.tone_samples
  FOR EACH ROW
  EXECUTE FUNCTION public.update_sample_count();


-- ╔══════════════════════════════════════════════════════════╗
-- ║  6. USAGE LOGS (per-operation tracking for analytics)   ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE public.usage_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,   -- rewrite, summarize, expand, tone_train, store_memory, recall_memory, migrate
  source_platform TEXT,            -- gmail, notion, chatgpt, claude, gemini
  tokens_used     INT DEFAULT 0,
  model_used      TEXT,            -- gpt-4o, claude-3-5-sonnet, etc.
  input_length    INT DEFAULT 0,
  output_length   INT DEFAULT 0,
  latency_ms      INT DEFAULT 0,
  success         BOOLEAN DEFAULT true,
  error_message   TEXT,
  
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_usage_logs_user ON public.usage_logs(user_id, created_at DESC);
CREATE INDEX idx_usage_logs_action ON public.usage_logs(action, created_at DESC);

-- Monthly usage view for quick quota checks
CREATE OR REPLACE VIEW public.monthly_usage AS
SELECT
  user_id,
  COUNT(*) FILTER (WHERE action = 'rewrite')   AS rewrites_this_month,
  COUNT(*) FILTER (WHERE action = 'summarize')  AS summarizes_this_month,
  COUNT(*) FILTER (WHERE action = 'expand')     AS expands_this_month,
  COUNT(*) FILTER (WHERE action IN ('rewrite', 'summarize', 'expand')) AS total_writes_this_month,
  SUM(tokens_used)                               AS total_tokens_this_month
FROM public.usage_logs
WHERE created_at >= date_trunc('month', now())
GROUP BY user_id;


-- ╔══════════════════════════════════════════════════════════╗
-- ║  7. CONTEXT MIGRATIONS (cross-AI transfer logs)         ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE public.context_migrations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source_platform   TEXT NOT NULL,
  target_platform   TEXT NOT NULL,
  original_text     TEXT NOT NULL,
  processed_summary TEXT,            -- LLM-summarized context
  context_prompt    TEXT,            -- Final prompt injected into target AI

  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_migrations_user ON public.context_migrations(user_id, created_at DESC);


-- ╔══════════════════════════════════════════════════════════╗
-- ║  8. ROW LEVEL SECURITY (RLS)                            ║
-- ╚══════════════════════════════════════════════════════════╝

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tone_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tone_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_migrations ENABLE ROW LEVEL SECURITY;

-- Profiles: users can only read/update their own profile
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Memories: users can only CRUD their own memories
CREATE POLICY "Users can view own memories"
  ON public.memories FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own memories"
  ON public.memories FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own memories"
  ON public.memories FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own memories"
  ON public.memories FOR DELETE
  USING (auth.uid() = user_id);

-- Tone Profiles: users can only CRUD their own
CREATE POLICY "Users can view own tone profiles"
  ON public.tone_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tone profiles"
  ON public.tone_profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tone profiles"
  ON public.tone_profiles FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own tone profiles"
  ON public.tone_profiles FOR DELETE
  USING (auth.uid() = user_id);

-- Tone Samples: users can only CRUD their own
CREATE POLICY "Users can view own tone samples"
  ON public.tone_samples FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tone samples"
  ON public.tone_samples FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own tone samples"
  ON public.tone_samples FOR DELETE
  USING (auth.uid() = user_id);

-- Usage Logs: users can only view their own
CREATE POLICY "Users can view own usage logs"
  ON public.usage_logs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own usage logs"
  ON public.usage_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Context Migrations: users can only CRUD their own
CREATE POLICY "Users can view own migrations"
  ON public.context_migrations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own migrations"
  ON public.context_migrations FOR INSERT
  WITH CHECK (auth.uid() = user_id);


-- ╔══════════════════════════════════════════════════════════╗
-- ║  9. HELPER FUNCTIONS                                    ║
-- ╚══════════════════════════════════════════════════════════╝

-- Semantic memory search function (called from backend)
CREATE OR REPLACE FUNCTION public.match_memories(
  query_embedding vector(1536),
  match_user_id   UUID,
  match_count     INT DEFAULT 5,
  match_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id              UUID,
  content         TEXT,
  source_platform TEXT,
  tags            TEXT[],
  similarity      FLOAT,
  created_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.source_platform,
    m.tags,
    1 - (m.embedding <=> query_embedding) AS similarity,
    m.created_at
  FROM public.memories m
  WHERE m.user_id = match_user_id
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Update the last_accessed_at and access_count when a memory is recalled
CREATE OR REPLACE FUNCTION public.touch_memory(memory_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.memories
  SET access_count = access_count + 1,
      last_accessed_at = now(),
      -- Boost importance when accessed frequently
      importance_score = LEAST(importance_score + 0.05, 1.0),
      updated_at = now()
  WHERE id = memory_id;
END;
$$;

-- Reset monthly usage counters (call via Supabase cron or pg_cron)
CREATE OR REPLACE FUNCTION public.reset_monthly_usage()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.profiles
  SET rewrites_used = 0,
      summarizes_used = 0,
      expands_used = 0,
      updated_at = now();
END;
$$;

-- Decay memory importance scores (run daily via cron)
CREATE OR REPLACE FUNCTION public.decay_memory_importance()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.memories
  SET importance_score = GREATEST(importance_score * 0.995, 0.1),
      updated_at = now()
  WHERE importance_score > 0.1
    AND last_accessed_at < now() - INTERVAL '7 days';
END;
$$;

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE TRIGGER set_memories_updated_at
  BEFORE UPDATE ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE TRIGGER set_tone_profiles_updated_at
  BEFORE UPDATE ON public.tone_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ╔══════════════════════════════════════════════════════════╗
-- ║  10. SEED DEFAULT DATA                                  ║
-- ╚══════════════════════════════════════════════════════════╝

-- Nothing to seed — profiles are auto-created on signup via trigger.
-- Tone profiles are created on-demand when user first trains a tone.

-- ✅ DONE — Schema ready!
-- 
-- Tables created:
--   • profiles          (user accounts, plans, Stripe, preferences)
--   • memories           (long-term memory with pgvector embeddings)
--   • tone_profiles      (style blueprints)
--   • tone_samples       (raw text samples for tone learning)
--   • usage_logs         (per-operation analytics)
--   • context_migrations (cross-AI transfer logs)
--
-- Functions created:
--   • handle_new_user()         — auto-create profile on signup
--   • update_memory_count()     — keep profile.memories_count in sync
--   • update_sample_count()     — keep tone_profiles.samples_count in sync
--   • match_memories()          — semantic vector search
--   • touch_memory()            — track memory access for predictive retention
--   • reset_monthly_usage()     — monthly quota reset (use with pg_cron)
--   • decay_memory_importance() — predictive retention decay (use with pg_cron)
--   • set_updated_at()          — auto-timestamp on updates
--
-- RLS enabled on all tables — each user can only access their own data.
