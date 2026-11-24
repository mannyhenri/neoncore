#!/usr/bin/env python3
"""
The phone app's mark: the captain's head (blue commander uniform, idle pose) in a neon ring.

Writes the iOS app icon set (every size its Contents.json names, no alpha), the launch-screen
image set (LaunchMark), the header mark (mobile/assets/brand/captain-mark*.png) and the legacy
mobile/assets icons, all from dashboard/public/world/bridge/captain-commander.png.
Run from anywhere:  python3 scripts/world/make_app_icon.py
"""
import json, os, re
from PIL import Image, ImageDraw, ImageFilter
BG=(4,6,12); NEON=(90,174,255)
M='mobile'
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(ROOT)
sheet=Image.open('dashboard/public/world/bridge/captain-commander.png').convert('RGBA')
f=sheet.crop((0,0,sheet.size[0]//4,sheet.size[1]//6))   # the idle pose, first frame
bust=f.crop((45,9,129,93))   # head and shoulders, centred on the face; the companion robot left out

def mark(S, bg=True, ring_glow=True):
    """The captain in a neon ring. bg=False leaves the outside transparent (for the header)."""
    c=Image.new('RGBA',(S,S),(BG+(255,)) if bg else (0,0,0,0))
    cx=cy=S//2; R=int(S*(0.40 if bg else 0.46))
    if ring_glow:
        g=Image.new('RGBA',(S,S),(0,0,0,0))
        ImageDraw.Draw(g).ellipse((cx-R-6,cy-R-6,cx+R+6,cy+R+6),outline=NEON+(200,),width=max(2,int(S*0.04)))
        c.alpha_composite(g.filter(ImageFilter.GaussianBlur(max(1,S*0.025))))
    disc=Image.new('RGBA',(S,S),(0,0,0,0)); ImageDraw.Draw(disc).ellipse((cx-R,cy-R,cx+R,cy+R),fill=BG+(255,))
    k=int(R*2*0.98); b=bust.resize((k,k),Image.NEAREST if k>=bust.size[0] else Image.LANCZOS)
    disc.alpha_composite(b,(cx-k//2,cy-k//2+int(R*0.10)))
    m=Image.new('L',(S,S),0); ImageDraw.Draw(m).ellipse((cx-R,cy-R,cx+R,cy+R),fill=255)
    disc.putalpha(Image.composite(disc.getchannel('A'),Image.new('L',(S,S),0),m))
    c.alpha_composite(disc)
    ImageDraw.Draw(c).ellipse((cx-R,cy-R,cx+R,cy+R),outline=NEON+(255,),width=max(1,int(S*0.022)))
    return c

big=mark(1024)
os.makedirs('designs/app-icon',exist_ok=True)
big.convert('RGB').save('designs/app-icon/captain-icon-1024.png')
for name in ['icon.png','adaptive-icon.png']: big.convert('RGB').save(f'{M}/assets/{name}')
sp=Image.new('RGB',(1284,1284),BG); sp.paste(mark(560).convert('RGB'),(362,362)); sp.save(f'{M}/assets/splash.png')

# Every iOS icon size the set names, rendered from the 1024 master (no alpha: Apple rejects it).
d=f'{M}/ios/NeonCore/Images.xcassets/AppIcon.appiconset'
for im in json.load(open(f'{d}/Contents.json'))['images']:
    fn=im.get('filename');
    if not fn: continue
    pt=float(im['size'].split('x')[0]); sc=int(im['scale'].rstrip('x')); px=round(pt*sc)
    small=big.convert('RGB').resize((px,px),Image.LANCZOS)
    if px < 30:
        # The smallest (20 px, older iPads): a little more dark around the face so it reads as a mark.
        inner=big.convert('RGB').resize((round(px*0.88),)*2,Image.LANCZOS)
        small=Image.new('RGB',(px,px),BG); small.paste(inner,((px-inner.size[0])//2,)*2)
    if px < 48:
        # At 20–40 px a downscaled 2 px ring blurs into the background: redraw it crisp and thicker.
        R=px*(0.352 if px < 30 else 0.40); w=1 if px < 30 else 2; o=px/2
        ImageDraw.Draw(small).ellipse((o-R-w/2,o-R-w/2,o+R+w/2,o+R+w/2),outline=NEON,width=w)
    small.save(f'{d}/{fn}')
    print(fn,px)

# The header mark (transparent outside the ring) and the launch-screen mark.
os.makedirs(f'{M}/assets/brand',exist_ok=True)
for s,suf in [(32,''),(64,'@2x'),(96,'@3x')]:
    mark(s*4,bg=False).resize((s,s),Image.LANCZOS).save(f'{M}/assets/brand/captain-mark{suf}.png')
L=f'{M}/ios/NeonCore/Images.xcassets/LaunchMark.imageset'; os.makedirs(L,exist_ok=True)
imgs=[]
for s,sc in [(140,1),(280,2),(420,3)]:
    fn=f'launch-mark@{sc}x.png'; mark(s*3 if s<400 else s,bg=False).resize((s,s),Image.LANCZOS).save(f'{L}/{fn}')
    imgs.append({'idiom':'universal','filename':fn,'scale':f'{sc}x'})
json.dump({'images':imgs,'info':{'version':1,'author':'xcode'}},open(f'{L}/Contents.json','w'),indent=2)
px=big.convert('RGB').load(); n=1024*1024; dark=neon=pink=0
for y in range(1024):
    for x in range(1024):
        r,g,b=px[x,y]; dark+=r<24 and g<24 and b<32; neon+=b>200 and g>130 and r<150; pink+=r>150 and g<120 and b>90
print('dark %.3f neon %.3f pink %.4f'%(dark/n,neon/n,pink/n))
