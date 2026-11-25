import math, sys

W = 1024; C = 512

def f(p): return f"{p[0]:.2f},{p[1]:.2f}"

# --- Squircle (superellipse, n=5) on Apple's 1024 grid: 824px body, 100px margin ---
def squircle(cx, cy, half, n=4.6, steps=720):
    pts = []
    for i in range(steps):
        t = 2*math.pi*i/steps
        c, s = math.cos(t), math.sin(t)
        x = half*math.copysign(abs(c)**(2/n), c)
        y = half*math.copysign(abs(s)**(2/n), s)
        pts.append((cx + x, cy + y))
    return "M" + " L".join(f(p) for p in pts) + " Z"

body = squircle(C, C, 412)

# --- Glyph geometry ---
R = 186; Wd = 74

def pt(a, r):  # degrees clockwise from 12 o'clock
    t = math.radians(a); return (C + r*math.sin(t), C - r*math.cos(t))

# Spent arc: tapers away (old account running dry)
a0, a1, w0, w1 = 122, 200, Wd, 14
N = 80
outer, inner = [], []
for i in range(N + 1):
    a = a0 + (a1 - a0)*i/N
    w = w0 + (w1 - w0)*(i/N)**1.4
    outer.append(pt(a, R + w/2)); inner.append(pt(a, R - w/2))
spent = "M" + f(outer[0]) + " " + " ".join("L" + f(p) for p in outer[1:])
spent += f" A{w1/2},{w1/2} 0 0 1 {f(inner[-1])} "
spent += " ".join("L" + f(p) for p in reversed(inner))
spent += f" A{w0/2},{w0/2} 0 0 1 {f(outer[0])} Z"

# Live arc: full weight, rounded tail, arrowhead (next account picks up)
b0, b1 = 226, 428
so, si = pt(b0, R + Wd/2), pt(b0, R - Wd/2)
eo, ei = pt(b1, R + Wd/2), pt(b1, R - Wd/2)
large = 1 if (b1 - b0) > 180 else 0
tip = pt(b1 + 34, R)
ho, hi = pt(b1, R + Wd/2 + 42), pt(b1, R - Wd/2 - 42)
live = (f"M{f(so)} A{R+Wd/2},{R+Wd/2} 0 {large} 1 {f(eo)} L{f(ho)} L{f(tip)} L{f(hi)} L{f(ei)} "
        f"A{R-Wd/2},{R-Wd/2} 0 {large} 0 {f(si)} A{Wd/2},{Wd/2} 0 0 1 {f(so)} Z")

# Centre: resume triangle, optically centred
cx, cy, s = C + 13, C, 60
tri = f"M{cx-s*0.55:.2f},{cy-s:.2f} L{cx+s*0.95:.2f},{cy:.2f} L{cx-s*0.55:.2f},{cy+s:.2f} Z"

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5AA2FF"/>
      <stop offset="0.55" stop-color="#3C6CF6"/>
      <stop offset="1" stop-color="#3A3FD8"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.12" r="0.75">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.30"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.55"/>
      <stop offset="0.25" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="0.85" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#0A0F5C" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="glyph" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#E4ECFF"/>
    </linearGradient>
    <linearGradient id="spent" x1="1" y1="0.2" x2="0.2" y2="1">
      <stop offset="0" stop-color="#FFD66B"/>
      <stop offset="1" stop-color="#FF8A3D"/>
    </linearGradient>
    <filter id="iconShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000000" flood-opacity="0.28"/>
    </filter>
    <filter id="glyphShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#141B7A" flood-opacity="0.40"/>
    </filter>
    <clipPath id="clip"><path d="{body}"/></clipPath>
  </defs>

  <g filter="url(#iconShadow)">
    <path d="{body}" fill="url(#bg)"/>
  </g>
  <g clip-path="url(#clip)">
    <rect width="1024" height="1024" fill="url(#glow)"/>
  </g>
  <path d="{body}" fill="none" stroke="url(#rim)" stroke-width="4"/>

  <g filter="url(#glyphShadow)">
    <circle cx="{C}" cy="{C}" r="{R}" fill="none" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="{Wd}"/>
    <path d="{spent}" fill="url(#spent)"/>
    <path d="{live}" fill="url(#glyph)" stroke="url(#glyph)" stroke-width="22" stroke-linejoin="round"/>
    <path d="{tri}" fill="url(#glyph)" stroke="url(#glyph)" stroke-width="30" stroke-linejoin="round"/>
  </g>
</svg>
'''
open(sys.argv[1], "w").write(svg)
