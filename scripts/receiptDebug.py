#!/usr/bin/env python3
"""
Receipt parse debugger — closes the loop between OCR output, the parser result, and
the REAL receipt photo, so we can SEE failures instead of guessing from rawText.

Usage:
    python3 scripts/receiptDebug.py <receipt.json>

  <receipt.json> is the stored parse blob (the big JSON column you paste from the DB
  row — the one with "image", "products", "footer"). Save it to a file, pass the path.

What it does:
  1. Reads MinIO creds from ../souply-api/.env and pulls the receipt JPEG (the bucket
     is private — plain GET returns AccessDenied) via a stdlib SigV4 presign.
  2. Overlays every parsed product band on the image (scaled from OCR space) + labels.
  3. Prints a per-product report and FLAGS the failure signatures we keep hitting:
       - a product with >2 A-prices in rawLines  (should have split)
       - a "blob": one product whose rawLines contain >1 strong NAME
       - "?" / empty names, and missing totals
  Output image: /tmp/receipt-debug-<n>.png  (open it, compare to the bands).

This is the pipeline: paste JSON -> run -> look at overlay + flags -> fix -> re-photo.
"""
import sys, os, re, json, hmac, hashlib, datetime, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.normpath(os.path.join(HERE, "..", "..", "souply-api", ".env"))


def load_env():
    env = {}
    with open(ENV) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k] = v
    return env


def presigned_get(env, key):
    ak, sk = env["MINIO_ACCESS_KEY"], env["MINIO_SECRET_KEY"]
    endpoint = f'{env["MINIO_ENDPOINT"]}:{env["MINIO_PORT"]}'
    bucket = env["MINIO_BUCKET"]
    region, service = "us-east-1", "s3"
    now = datetime.datetime.now(datetime.timezone.utc)
    amzdate, datestamp = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    cu = f"/{bucket}/{urllib.parse.quote(key)}"
    cs = f"{datestamp}/{region}/{service}/aws4_request"
    qp = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{ak}/{cs}",
        "X-Amz-Date": amzdate,
        "X-Amz-Expires": "120",
        "X-Amz-SignedHeaders": "host",
    }
    cqs = "&".join(f'{urllib.parse.quote(k, safe="-_.~")}={urllib.parse.quote(v, safe="-_.~")}'
                   for k, v in sorted(qp.items()))
    creq = f"GET\n{cu}\n{cqs}\nhost:{endpoint}\n\nhost\nUNSIGNED-PAYLOAD"
    sts = "\n".join(["AWS4-HMAC-SHA256", amzdate, cs, hashlib.sha256(creq.encode()).hexdigest()])
    sign = lambda k, m: hmac.new(k, m.encode(), hashlib.sha256).digest()
    ks = sign(sign(sign(sign(("AWS4" + sk).encode(), datestamp), region), service), "aws4_request")
    sig = hmac.new(ks, sts.encode(), hashlib.sha256).hexdigest()
    return f"http://{endpoint}{cu}?{cqs}&X-Amz-Signature={sig}"


NAME_RE = re.compile(r"[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]{4,}")
APRICE_RE = re.compile(r"\d\s*[ABC]\s*$")
LABEL_RE = re.compile(r"NUOL|KORTEL|KUPON|TA[SŠ]KA|MAI[SŠ]ELIS|kg\b", re.I)


def report(data):
    prods = data.get("products", [])
    print(f"\n{'#':>2}  {'name':32} {'price':>7} {'qty':>6}  flags")
    print("-" * 78)
    for i, p in enumerate(prods):
        raws = p.get("rawLines", [])
        aprices = sum(1 for l in raws if APRICE_RE.search(l))
        names = [l for l in raws if NAME_RE.search(l) and not LABEL_RE.search(l)]
        flags = []
        if aprices > 2:
            flags.append(f"!{aprices} A-prices (should split)")
        if len(names) > 1:
            flags.append(f"!BLOB ({len(names)} names)")
        if p.get("name") in ("?", "", None):
            flags.append("?name")
        nm = (p.get("name") or "?")[:32]
        print(f"{i:>2}  {nm:32} {p.get('price','?'):>7} {p.get('quantity','?'):>6}  {'  '.join(flags)}")
    print()
    return prods


def overlay(data, jpg, out):
    from PIL import Image, ImageDraw
    im = Image.open(jpg).convert("RGB")
    W, H = im.size
    ow, oh = data["image"]["width"], data["image"]["height"]
    sx, sy = W / ow, H / oh
    d = ImageDraw.Draw(im)
    colors = [(255, 60, 60), (40, 140, 255), (40, 200, 80), (230, 60, 230), (255, 170, 0)]
    ymax = 0
    for i, p in enumerate(data.get("products", [])):
        r = p.get("region", {})
        c = colors[i % len(colors)]
        xl, xr = r.get("xLeft", 0) * sx, r.get("xRight", ow) * sx
        ylt = r.get("yLeftTop", r.get("yTop", 0)) * sy
        yrt = r.get("yRightTop", r.get("yTop", 0)) * sy
        ylb = r.get("yLeftBottom", r.get("yBottom", 0)) * sy
        yrb = r.get("yRightBottom", r.get("yBottom", 0)) * sy
        d.polygon([(xl, ylt), (xr, yrt), (xr, yrb), (xl, ylb)], outline=c, width=2)
        d.text((xl + 3, ylt + 1), f"{i}:{(p.get('name') or '?')[:16]}", fill=c)
        ymax = max(ymax, yrb, ylb)
    crop = im.crop((0, 0, W, min(H, int(ymax + 40))))
    crop = crop.resize((crop.width * 2, crop.height * 2))
    crop.save(out)
    print(f"overlay -> {out}  ({crop.size[0]}x{crop.size[1]})")


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    data = json.load(open(sys.argv[1]))
    fp = data.get("image", {}).get("filePath", "")
    key = fp.rsplit("/", 1)[-1]
    n = re.sub(r"\D", "", key)[-2:] or "x"
    env = load_env()
    jpg = f"/tmp/receipt-debug-{n}.jpg"
    out = f"/tmp/receipt-debug-{n}.png"
    try:
        urllib.request.urlretrieve(presigned_get(env, key), jpg)
        print(f"pulled {key} -> {jpg}")
    except Exception as e:
        print(f"(could not pull image: {e}) — report only")
        jpg = None
    report(data)
    if jpg:
        overlay(data, jpg, out)


if __name__ == "__main__":
    main()
