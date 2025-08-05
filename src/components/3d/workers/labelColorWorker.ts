
interface GetVerticesMsg {
  reqId: number;
  type: 'GET_VERTICES';
  width: number;
  positionsXY: Float32Array;
  polygon: Float32Array;
}

type WorkerInMsg = GetVerticesMsg;

type WorkerOutMsg = { reqId: number; type: 'VERTICES_READY'; indices: Uint32Array } | { reqId: number; type: 'ERROR'; error: string };

// Winding-number algorithm: works for self-intersecting polygons (e.g., spiral)
const isLeft = (xi: number, yi: number, xj: number, yj: number, xk: number, yk: number): number => {
  return (xj - xi) * (yk - yi) - (xk - xi) * (yj - yi);
};

const pointInPoly = (x: number, y: number, poly: Float32Array): boolean => {
  let wn = 0; // winding number counter
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];

    if (yi <= y) {
      // an upward crossing
      if (yj > y && isLeft(xi, yi, xj, yj, x, y) > 0) {
        wn++;
      }
    } else {
      // a downward crossing
      if (yj <= y && isLeft(xi, yi, xj, yj, x, y) < 0) {
        wn--;
      }
    }
  }
  return wn !== 0;
};

self.onmessage = (evt: MessageEvent<WorkerInMsg>) => {
  const msg = evt.data;
  const send = (data: WorkerOutMsg) => (self as unknown as Worker).postMessage(data, data.type === 'VERTICES_READY' ? [data.indices.buffer] : undefined);

  try {
    if (msg.type === 'GET_VERTICES') {
      const { reqId, positionsXY, polygon } = msg;
      const vertCount = positionsXY.length / 2;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < polygon.length; i += 2) {
        const px = polygon[i];
        const py = polygon[i + 1];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }

      const indices: number[] = [];
      for (let v = 0; v < vertCount; v++) {
        const x = positionsXY[v * 2];
        const y = positionsXY[v * 2 + 1];
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        if (pointInPoly(x, y, polygon)) {
          indices.push(v);
        }
      }

      send({ reqId, type: 'VERTICES_READY', indices: new Uint32Array(indices) });
    }
  } catch (e) {
    send({ reqId: msg.reqId, type: 'ERROR', error: (e instanceof Error ? e.message : String(e)) });
  }
};