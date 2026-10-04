import { describe, expect, it } from 'vitest';
import { candidateMediaIdentity, mediaIdentityKey, sourceRequestKey } from '../src/mediaIdentity';

describe('media identity', () => {
  it('recognizes the same case-sensitive YouTube video across accepted hosts and ordinary tracking variants', () => {
    const urls = [
      'https://youtube.com/shorts/AbCdEf123_-',
      'http://WWW.YOUTUBE.COM/shorts/AbCdEf123_-/?utm_source=x&fbclid=y#fragment',
      'https://m.youtube.com/shorts/AbCdEf123_-?igsh=z',
    ];

    for (const url of urls) {
      expect(candidateMediaIdentity(url)).toEqual({ platform: 'youtube', videoId: 'AbCdEf123_-' });
    }
    expect(mediaIdentityKey({ platform: 'youtube', videoId: 'AbCdEf123_-' }))
      .not.toBe(mediaIdentityKey({ platform: 'youtube', videoId: 'abCdEf123_-' }));
  });

  it('coordinates equivalent Instagram post requests without conflating their selected videos', () => {
    const whole = sourceRequestKey('https://instagram.com/p/Code_123/?igsh=x');
    expect(sourceRequestKey('http://www.instagram.com/reel/Code_123/#fragment')).toBe(whole);
    expect(sourceRequestKey('https://instagram.com/p/Code_123/?img_index=3'))
      .toBe(sourceRequestKey('https://www.instagram.com/reel/Code_123/?img_index=3&utm_source=x'));
    expect(sourceRequestKey('https://instagram.com/p/Code_123/?img_index=3')).not.toBe(whole);
    expect(sourceRequestKey('https://instagram.com/p/Code_123/?img_index=1'))
      .not.toBe(sourceRequestKey('https://instagram.com/p/Code_123/?img_index=3'));
    expect(candidateMediaIdentity('https://instagram.com/reel/Code_123/')).toBeNull();
  });

  it.each([
    'https://youtube.com/shorts/too-short',
    'https://youtube.com/shorts/%41bCdEf123_-',
    'https://youtube.com/SHORTS/AbCdEf123_-',
    'https://youtube.com/shorts/AbCdEf123_-/extra',
    'https://youtube.com/shorts/Another123_/../AbCdEf123_-',
    'https://youtube.com/shorts/Another123_/%2e%2e/AbCdEf123_-',
    'https://youtube.com/ignored/../shorts/AbCdEf123_-',
    'https://youtube.com/shorts/AbCdEf123_-\\',
    'https://youtube.com/shorts/AbCdEf123_-?t=5',
    'https://youtube.com/watch?v=AbCdEf123_-',
    'https://youtu.be/AbCdEf123_-',
    'ftp://youtube.com/shorts/AbCdEf123_-',
    'https://user@youtube.com/shorts/AbCdEf123_-',
    'https://youtube.com:444/shorts/AbCdEf123_-',
  ])('does not guess an offline video identity for %s', (url) => {
    expect(candidateMediaIdentity(url)).toBeNull();
  });

  it('does not equate uncertain Instagram URL spellings before metadata resolution', () => {
    const ordinary = sourceRequestKey('https://www.instagram.com/p/Code_123/');
    for (const url of [
      'https://m.instagram.com/p/Code_123/',
      'https://www.instagram.com/p/%43ode_123/',
      'https://www.instagram.com/p/Code_123/extra',
      'https://www.instagram.com/p/Other_123/../Code_123/',
      'https://www.instagram.com/p/Other_123/%2E%2E/Code_123/',
      'https://www.instagram.com/p/Code_123/?other=x',
      'https://www.instagram.com/p/Code_123/?img_index=0',
      'https://www.instagram.com/p/Code_123/?img_index=1&img_index=3',
      'https://www.instagram.com/P/Code_123/',
      'https://user@www.instagram.com/p/Code_123/',
    ]) expect(sourceRequestKey(url)).not.toBe(ordinary);
    expect(sourceRequestKey('https://instagram.com/p/ABCDEFGHIJKLMNOPQRSTUVWXYZ123/'))
      .not.toBe(sourceRequestKey('https://instagram.com/reel/ABCDEFGHIJKLMNOPQRSTUVWXYZ123/'));
    expect(mediaIdentityKey({ platform: 'instagram', postId: 'post:a', itemId: 'b' }))
      .not.toBe(mediaIdentityKey({ platform: 'instagram', postId: 'post', itemId: 'a:b' }));
  });
});
