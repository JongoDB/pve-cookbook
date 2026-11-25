import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http';
import { rateLimitMessage, rateLimitedUntil, secondsLeft, setupTokenMessage } from './auth';

describe('login rate limiting', () => {
  it('formats the message', () => {
    expect(rateLimitMessage(30)).toBe('Too many attempts. Try again in 30 seconds.');
    expect(rateLimitMessage(1)).toBe('Too many attempts. Try again in 1 second.');
    expect(rateLimitMessage(2.2)).toBe('Too many attempts. Try again in 3 seconds.');
    expect(rateLimitMessage(0)).toBe('Too many attempts. Try again in 1 second.');
  });

  it('locks until now + retryAfter for 429 rate_limited only', () => {
    expect(rateLimitedUntil(new ApiError(429, 'rate_limited', 'x', 12), 1000)).toBe(13_000);
    expect(rateLimitedUntil(new ApiError(429, 'rate_limited', 'x'), 0)).toBe(30_000); // no retryAfter: 30 s default
    expect(rateLimitedUntil(new ApiError(401, 'auth_failed', 'x'), 0)).toBeNull();
    expect(rateLimitedUntil(new Error('network'), 0)).toBeNull();
  });

  it('counts down to zero', () => {
    expect(secondsLeft(13_000, 1000)).toBe(12);
    expect(secondsLeft(13_000, 12_500)).toBe(1);
    expect(secondsLeft(13_000, 13_000)).toBe(0);
    expect(secondsLeft(null, 0)).toBe(0);
  });
});

describe('setup code errors', () => {
  it('explains missing and invalid codes', () => {
    expect(setupTokenMessage(new ApiError(403, 'setup_token_required', 'x'))).toMatch(/^Enter the setup code/);
    expect(setupTokenMessage(new ApiError(403, 'setup_token_invalid', 'x'))).toMatch(/not valid.*\/var\/lib\/galley\/setup-token/);
    expect(setupTokenMessage(new ApiError(400, 'invalid', 'x'))).toBeNull();
  });
});
