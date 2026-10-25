import numpy as np, re, sys
def read_hdr(path):
    f = open(path,'rb'); data = f.read(); f.close()
    i = 0
    # header
    while True:
        j = data.index(b'\n', i); line = data[i:j]; i = j+1
        if line == b'': break
    j = data.index(b'\n', i); res = data[i:j].decode(); i = j+1
    m = re.match(r'-Y (\d+) \+X (\d+)', res); H, W = int(m.group(1)), int(m.group(2))
    out = np.zeros((H, W, 4), np.uint8)
    buf = np.frombuffer(data, np.uint8)
    p = i
    for y in range(H):
        # new RLE
        assert buf[p]==2 and buf[p+1]==2
        p += 4
        for c in range(4):
            x = 0
            row = out[y,:,c]
            while x < W:
                n = int(buf[p]); p += 1
                if n > 128:
                    n -= 128; row[x:x+n] = buf[p]; p += 1
                else:
                    row[x:x+n] = buf[p:p+n]; p += n
                x += n
    e = out[...,3].astype(np.int32)
    scale = np.where(e>0, np.ldexp(1.0, e-136), 0.0)
    return out[...,:3].astype(np.float32) * scale[...,None]
