-- packages/core/src/rate-limit/token-bucket.lua
-- KEYS[1] = bucket key (hash: tokens, ts), KEYS[2] = pause key (string: epoch ms until which bucket is paused)
-- ARGV: capacity, refill_per_ms, cost, now_ms, ttl_ms
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])
local now      = tonumber(ARGV[4])
local ttl      = tonumber(ARGV[5])

local paused_until = tonumber(redis.call('GET', KEYS[2]) or '0')
if paused_until > now then
  return { 0, paused_until - now }            -- denied, wait ms
end

local data   = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1]) or capacity
local ts     = tonumber(data[2]) or now
tokens = math.min(capacity, tokens + (now - ts) * rate)

local allowed, wait = 0, 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], ttl)
return { allowed, wait }
