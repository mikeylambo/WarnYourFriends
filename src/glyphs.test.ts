import { describe, expect, it } from 'vitest';
import { InputGlyphRegistry } from '@slu/web-shell';
import { padFamily, registerGlyphs } from './glyphs';

describe('button labels', () => {
  it('knows a PS4 pad by name or by Sony vendor id', () => {
    expect(padFamily('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)')).toBe('playstation');
    expect(padFamily('DUALSHOCK 4 Wireless Controller')).toBe('playstation');
    expect(padFamily('054c-05c4-Wireless Controller')).toBe('playstation');
    expect(padFamily('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('xbox');
    expect(padFamily('Some Pad (Vendor: 1234 Product: 5678)')).toBe('generic-gamepad');
  });

  it('labels PlayStation buttons as L1/R1/L2/✕, unknown pads as Xbox', () => {
    const r = new InputGlyphRegistry();
    registerGlyphs(r);
    expect(['ability', 'shoulder', 'brake', 'accept', 'pause'].map((a) => r.resolve(a, 'playstation')?.label)).toEqual(['L1', 'R1', 'L2', '✕', 'Options']);
    expect(['ability', 'shoulder', 'brake', 'accept'].map((a) => r.resolve(a, 'generic-gamepad')?.label)).toEqual(['LB', 'RB', 'LT', 'A']);
    expect(r.resolve('ability', 'keyboard-mouse')?.label).toBe('E');
  });
});
