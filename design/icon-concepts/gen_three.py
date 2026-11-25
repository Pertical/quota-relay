import math, sys, os

C = 512
OUT = sys.argv[1]

def f(p): return f"{p[0]:.2f},{p[1]:.2f}"

def squircle(cx=C, cy=C, half=412, n=4.6, steps=720):
    pts = []
    for i in range(steps):
        t = 2*math.pi*i/steps
        c, s = math.cos(t), math.sin(t)
        pts.append((cx + half*math.copysign(abs(c)**(2/n), c),
                    cy + half*math.copysign(abs(s)**(2/n), s)))
    return "M" + " L".join(f(p) for p in pts) + " Z"

BODY = squircle()

def pt(a, r, cx=C, cy=C):  # degrees clockwise from 12 o'clock
    t = math.radians(a); return (cx + r*math.sin(t), cy - r*math.cos(t))

def frame(bg_stops, inner, extra_defs="", rim_dark="#000000", glow=0.30):
    stops = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in bg_stops)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">{stops}</linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.10" r="0.75">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="{glow}"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.6"/>
      <stop offset="0.25" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="0.85" stop-color="{rim_dark}" stop-opacity="0"/>
      <stop offset="1" stop-color="{rim_dark}" stop-opacity="0.3"/>
    </linearGradient>
    <filter id="iconShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity="0.28"/>
    </filter>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.22"/>
    </filter>
    <clipPath id="clip"><path d="{BODY}"/></clipPath>
    {extra_defs}
  </defs>
  <g filter="url(#iconShadow)"><path d="{BODY}" fill="url(#bg)"/></g>
  <g clip-path="url(#clip)"><rect width="1024" height="1024" fill="url(#glow)"/></g>
  <path d="{BODY}" fill="none" stroke="url(#rim)" stroke-width="4"/>
  {inner}
</svg>
'''

# ---------- 1. Battery handoff ----------
def battery(x, y, w, h, level, fill_id, stroke="#1D1D1F", sw=26, opacity=1):
    r = h*0.30
    pad = sw/2 + 14
    fw = max((w - 2*pad)*level, h*0.2)
    ir = r - pad*0.55
    nub_w, nub_h = 30, h*0.36
    return f'''<g opacity="{opacity}">
    <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="#FFFFFF" stroke="{stroke}" stroke-width="{sw}"/>
    <rect x="{x+pad}" y="{y+pad}" width="{fw}" height="{h-2*pad}" rx="{ir}" fill="url(#{fill_id})"/>
    <path d="M{x+w+sw/2-2},{y+h/2-nub_h/2} h{nub_w-12} a12,12 0 0 1 12,12 v{nub_h-24} a12,12 0 0 1 -12,12 h-{nub_w-12} Z" fill="{stroke}"/>
  </g>'''

def design_battery():
    bw, bh = 380, 168
    x = 512 - bw/2 + 46
    y1, y2 = 300, 556
    defs = '''
    <linearGradient id="low" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFB340"/><stop offset="1" stop-color="#FF7A1A"/></linearGradient>
    <linearGradient id="full" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5BE37A"/><stop offset="1" stop-color="#28C24E"/></linearGradient>
    <linearGradient id="arrow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3D8BFF"/><stop offset="1" stop-color="#1E62E6"/></linearGradient>'''
    # handoff arrow on the left: leaves the top battery, curves down into the bottom one
    sx, sy = x - 22, y1 + bh/2
    ex, ey = x - 40, y2 + bh/2
    cx = x - 160
    arrow = (f'<path d="M{sx},{sy} C{cx},{sy} {cx},{ey} {ex-60},{ey}" fill="none" stroke="url(#arrow)" '
             f'stroke-width="40" stroke-linecap="round"/>'
             f'<path d="M{ex-70},{ey-44} L{ex-8},{ey} L{ex-70},{ey+44} Z" fill="#1E62E6" stroke="#1E62E6" '
             f'stroke-width="18" stroke-linejoin="round"/>')
    inner = f'''<g filter="url(#soft)">
    {battery(x, y1, bw, bh, 0.12, "low", stroke="#AEAEB2")}
    {battery(x, y2, bw, bh, 1.0, "full")}
    {arrow}
  </g>'''
    return frame([(0, "#FFFFFF"), (1, "#E3E6EC")], inner, defs, rim_dark="#5A6070", glow=0.0)

# ---------- 2. Hourglass flip ----------
def design_hourglass():
    defs = '''
    <linearGradient id="sand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF1B8"/><stop offset="1" stop-color="#FFD45C"/></linearGradient>
    <clipPath id="glass"><path id="gp" d="M384,338 L640,338 C640,440 536,470 528,512 C536,554 640,584 640,686 L384,686 C384,584 488,554 496,512 C488,470 384,440 384,338 Z"/></clipPath>'''
    glass = "M384,338 L640,338 C640,440 536,470 528,512 C536,554 640,584 640,686 L384,686 C384,584 488,554 496,512 C488,470 384,440 384,338 Z"
    # flip arrows around the hourglass
    R = 336
    def arc(a0, a1):
        p0, p1 = pt(a0, R), pt(a1, R)
        tip = pt(a1 + 16, R)
        ho, hi = pt(a1, R + 34), pt(a1, R - 34)
        return (f'<path d="M{f(p0)} A{R},{R} 0 0 1 {f(p1)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.92" '
                f'stroke-width="30" stroke-linecap="round"/>'
                f'<path d="M{f(ho)} L{f(tip)} L{f(hi)} Z" fill="#FFFFFF" fill-opacity="0.92" stroke="#FFFFFF" '
                f'stroke-opacity="0.92" stroke-width="12" stroke-linejoin="round"/>')
    inner = f'''<g filter="url(#soft)">
    {arc(48, 128)}
    {arc(228, 308)}
    <path d="{glass}" fill="#FFFFFF" fill-opacity="0.18"/>
    <g clip-path="url(#glass)">
      <path d="M384,486 Q512,470 640,486 L640,520 L384,520 Z" fill="url(#sand)"/>
      <path d="M370,700 C400,600 470,580 512,578 C554,580 624,600 654,700 Z" fill="url(#sand)"/>
      <rect x="506" y="505" width="12" height="90" rx="6" fill="#FFE07A"/>
    </g>
    <path d="{glass}" fill="none" stroke="#FFFFFF" stroke-width="22" stroke-linejoin="round"/>
    <rect x="346" y="300" width="332" height="44" rx="22" fill="#FFFFFF"/>
    <rect x="346" y="680" width="332" height="44" rx="22" fill="#FFFFFF"/>
  </g>'''
    return frame([(0, "#FFB457"), (0.55, "#FF7F50"), (1, "#F2546B")], inner, defs, rim_dark="#7A1630")

# ---------- 3. Fuel gauge ----------
def lerp(c1, c2, t):
    a = [int(c1[i:i+2], 16) for i in (1, 3, 5)]
    b = [int(c2[i:i+2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(a[i]+(b[i]-a[i])*t):02X}" for i in range(3))

def design_gauge():
    cy = 560
    R, Wd = 260, 52
    a0, a1 = -120, 120
    track = (f'<path d="M{f(pt(a0,R,cy=cy))} A{R},{R} 0 1 1 {f(pt(a1,R,cy=cy))}" fill="none" '
             f'stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="{Wd}" stroke-linecap="round"/>')
    # coloured band: amber (empty) -> green (full), drawn as short segments
    segs = []
    N = 48
    for i in range(N):
        s, e = a0 + (a1-a0)*i/N, a0 + (a1-a0)*(i+1)/N + 0.6
        t = i/(N-1)
        col = lerp("#FF9F0A", "#FFD60A", t*2) if t < 0.5 else lerp("#FFD60A", "#30D158", (t-0.5)*2)
        segs.append(f'<path d="M{f(pt(s,R,cy=cy))} A{R},{R} 0 0 1 {f(pt(e,R,cy=cy))}" fill="none" '
                    f'stroke="{col}" stroke-width="{Wd}"/>')
    caps = (f'<circle cx="{pt(a0,R,cy=cy)[0]:.2f}" cy="{pt(a0,R,cy=cy)[1]:.2f}" r="{Wd/2}" fill="#FF9F0A"/>'
            f'<circle cx="{pt(a1,R,cy=cy)[0]:.2f}" cy="{pt(a1,R,cy=cy)[1]:.2f}" r="{Wd/2}" fill="#30D158"/>')
    ticks = []
    for i in range(9):
        a = a0 + (a1-a0)*i/8
        p0, p1 = pt(a, R-Wd/2-30, cy=cy), pt(a, R-Wd/2-(62 if i % 4 == 0 else 46), cy=cy)
        ticks.append(f'<line x1="{p0[0]:.2f}" y1="{p0[1]:.2f}" x2="{p1[0]:.2f}" y2="{p1[1]:.2f}" '
                     f'stroke="#FFFFFF" stroke-opacity="{0.85 if i % 4 == 0 else 0.4}" stroke-width="12" stroke-linecap="round"/>')
    def needle(a, op):
        tip = pt(a, R-70, cy=cy); l, r = pt(a-90, 18, cy=cy), pt(a+90, 18, cy=cy)
        return (f'<path d="M{f(l)} L{f(tip)} L{f(r)} Z" fill="#FFFFFF" fill-opacity="{op}" stroke="#FFFFFF" '
                f'stroke-opacity="{op}" stroke-width="10" stroke-linejoin="round"/>')
    # sweep trail from E to F
    sw0, sw1, sr = -100, 70, R-110
    sweep = (f'<path d="M{f(pt(sw0,sr,cy=cy))} A{sr},{sr} 0 0 1 {f(pt(sw1,sr,cy=cy))}" fill="none" '
             f'stroke="url(#trail)" stroke-width="16" stroke-linecap="round"/>')
    defs = '''<linearGradient id="trail" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0.55"/></linearGradient>'''
    font = 'font-family="-apple-system, SF Pro Rounded, Helvetica Neue, sans-serif" font-weight="700"'
    lp, rp = pt(a0, R, cy=cy), pt(a1, R, cy=cy)
    labels = (f'<text x="{lp[0]:.0f}" y="{lp[1]+100:.0f}" text-anchor="middle" font-size="64" {font} fill="#FF9F0A">E</text>'
              f'<text x="{rp[0]:.0f}" y="{rp[1]+100:.0f}" text-anchor="middle" font-size="64" {font} fill="#30D158">F</text>')
    inner = f'''<g filter="url(#soft)">
    {track}{''.join(segs)}{caps}
    {''.join(ticks)}
    {sweep}
    {needle(-104, 0.22)}
    {needle(76, 1)}
    <circle cx="512" cy="{cy}" r="38" fill="#FFFFFF"/>
    <circle cx="512" cy="{cy}" r="14" fill="#2C2C2E"/>
    {labels}
  </g>'''
    return frame([(0, "#48484A"), (0.5, "#2C2C2E"), (1, "#161618")], inner, defs, rim_dark="#000000", glow=0.18)

for name, fn in [("battery", design_battery), ("hourglass", design_hourglass), ("gauge", design_gauge)]:
    open(os.path.join(OUT, f"icon-{name}.svg"), "w").write(fn())
