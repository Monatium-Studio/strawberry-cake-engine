/*
 * Portions of this file are adapted from `generateTileCache` in @recast-navigation/generators 0.44.0
 * (https://github.com/isaac-mason/recast-navigation-js).
 *
 * The MIT License
 * Copyright © 2025 Isaac Mason
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * See THIRD_PARTY_NOTICES.md.
 */
import {
  ChunkIdsArray,
  Detour,
  DetourTileCacheParams,
  NavMesh,
  NavMeshParams,
  Raw,
  RecastBuildContext,
  RecastChunkyTriMesh,
  TileCache,
  TileCacheData,
  TileCacheMeshProcess,
  TriangleAreasArray,
  TrianglesArray,
  VerticesArray,
  allocCompactHeightfield,
  allocHeightfield,
  allocHeightfieldLayerSet,
  buildCompactHeightfield,
  buildHeightfieldLayers,
  buildTileCacheLayer,
  cloneRcConfig,
  createHeightfield,
  createRcConfig,
  erodeWalkableArea,
  filterLedgeSpans,
  filterLowHangingWalkableObstacles,
  filterWalkableLowHeightSpans,
  freeCompactHeightfield,
  freeHeightfield,
  freeHeightfieldLayerSet,
  getHeightfieldLayerAreas,
  getHeightfieldLayerCons,
  getHeightfieldLayerHeights,
  FloatArray,
  markConvexPolyArea,
  markWalkableTriangles,
  rasterizeTriangles,
  statusFailed,
  type OffMeshConnectionParams,
  type Vector3Tuple,
} from '@recast-navigation/core';

/**
 * 타일 캐시 내비메시 생성 (`@recast-navigation/generators`의 generateTileCache를 옮겨 와 둘로 나눈 것).
 *   1) TileRasterizer: 타일마다 높이장 → 침식 → 층 → 압축 바이트 (워커에서도 돈다: bake.worker.ts)
 *   2) assembleTileCache: 압축 층을 모아 TileCache·NavMesh를 만들고 타일 메시를 짓는다 (메인)
 * 층 수를 다 센 뒤 용량을 정하므로 expectedLayersPerTile을 추측하지 않는다. 오프메시 링크는 타일 메시 처리에서 붙인다.
 */

/** 폴리곤 플래그: 걷기. 0이면 끊긴 섬(가지치기)이라 길찾기에서 빠진다 */
export const POLY_WALK = 1;

export interface BakeConfig {
  bmin: Vector3Tuple;
  bmax: Vector3Tuple;
  /** 복셀 가로·높이 (m) */
  cs: number;
  ch: number;
  /** 에이전트 (m, 도) */
  radius: number;
  height: number;
  climb: number;
  slope: number;
  /** 타일 한 변 (복셀) */
  tileSize: number;
  maxSimplificationError?: number;
}

export interface BakeGrid {
  tilesX: number;
  tilesZ: number;
  /** 실제 쓴 복셀 값 */
  voxels: { radius: number; height: number; climb: number };
}

function voxels(c: BakeConfig) {
  return {
    radius: Math.max(0, Math.ceil(c.radius / c.cs - 1e-4)),
    height: Math.max(3, Math.ceil(c.height / c.ch - 1e-4)),
    climb: Math.max(0, Math.floor(c.climb / c.ch + 1e-4)),
  };
}

export function bakeGrid(c: BakeConfig): BakeGrid {
  const gw = Math.floor((c.bmax[0] - c.bmin[0]) / c.cs + 0.5);
  const gh = Math.floor((c.bmax[2] - c.bmin[2]) / c.cs + 0.5);
  const ts = Math.floor(c.tileSize);
  return { tilesX: Math.floor((gw + ts - 1) / ts), tilesZ: Math.floor((gh + ts - 1) / ts), voxels: voxels(c) };
}

function rcConfig(c: BakeConfig) {
  const v = voxels(c);
  const config = createRcConfig({
    cs: c.cs,
    ch: c.ch,
    walkableSlopeAngle: c.slope,
    walkableHeight: v.height,
    walkableClimb: v.climb,
    walkableRadius: v.radius,
    maxSimplificationError: c.maxSimplificationError ?? 1.3,
    maxVertsPerPoly: 6,
    tileSize: c.tileSize,
  });
  config.borderSize = v.radius + 3;
  config.width = c.tileSize + config.borderSize * 2;
  config.height = c.tileSize + config.borderSize * 2;
  return config;
}

/** 속이 찬 기둥 (geometry.ts NavSolid와 같은 모양: 워커로 넘기려고 여기서도 정의) */
export interface SolidPrism {
  xz: number[];
  ymin: number;
  ymax: number;
}

/** 타일 하나씩 압축 층을 굽는다. 형상은 한 번 넣고 여러 타일에 쓴다 */
export class TileRasterizer {
  /** 속 지우기: 볼록 껍질(xyz 배열)과 xz 경계 */
  private readonly solids: { verts: InstanceType<typeof FloatArray>; n: number; ymin: number; ymax: number; x0: number; x1: number; z0: number; z1: number }[] = [];
  private readonly ctx = new RecastBuildContext();
  private readonly verts = new VerticesArray();
  private readonly tris = new TrianglesArray();
  private readonly chunky = new RecastChunkyTriMesh();
  private readonly chunkIds = new ChunkIdsArray();
  private readonly compressor = new Raw.RecastFastLZCompressor();
  private readonly config: ReturnType<typeof rcConfig>;
  private readonly nv: number;
  private readonly maxChunkIds = 1024;

  constructor(
    positions: Float32Array,
    indices: Uint32Array,
    private readonly c: BakeConfig,
    solids: SolidPrism[] = [],
  ) {
    for (const sd of solids) {
      const n = sd.xz.length / 2;
      const xyz: number[] = [];
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = sd.xz[i * 2];
        const z = sd.xz[i * 2 + 1];
        xyz.push(x, sd.ymin, z);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      const verts = new FloatArray();
      verts.copy(xyz);
      this.solids.push({ verts, n, ymin: sd.ymin, ymax: sd.ymax, x0, x1, z0, z1 });
    }
    this.nv = positions.length / 3;
    this.verts.copy(positions);
    this.tris.copy(new Int32Array(indices.buffer, indices.byteOffset, indices.length));
    if (!this.chunky.init(this.verts, this.tris, indices.length / 3, 256)) throw new Error('[nav] chunky tri mesh 실패');
    this.chunkIds.resize(this.maxChunkIds);
    this.config = rcConfig(c);
  }

  /** (tx, ty) 타일의 층들 → 압축 바이트 (복사본) */
  rasterize(tx: number, ty: number): Uint8Array[] {
    const { ctx, c, chunky, verts, nv } = this;
    const tc = cloneRcConfig(this.config);
    const tcs = c.tileSize * c.cs;
    const border = tc.borderSize * tc.cs;
    const bmin: Vector3Tuple = [c.bmin[0] + tx * tcs - border, c.bmin[1], c.bmin[2] + ty * tcs - border];
    const bmax: Vector3Tuple = [c.bmin[0] + (tx + 1) * tcs + border, c.bmax[1], c.bmin[2] + (ty + 1) * tcs + border];
    for (let i = 0; i < 3; i++) {
      tc.set_bmin(i, bmin[i]);
      tc.set_bmax(i, bmax[i]);
    }
    const out: Uint8Array[] = [];
    const n = chunky.getChunksOverlappingRect([bmin[0], bmin[2]], [bmax[0], bmax[2]], this.chunkIds, this.maxChunkIds);
    if (n === 0) {
      Raw.destroy(tc);
      return out;
    }
    const hf = allocHeightfield();
    if (!createHeightfield(ctx, hf, tc.width, tc.height, bmin, bmax, tc.cs, tc.ch)) {
      freeHeightfield(hf);
      Raw.destroy(tc);
      return out;
    }
    for (let i = 0; i < n; i++) {
      const nodeId = this.chunkIds.get(i);
      const nNodeTris = chunky.nodes(nodeId).n;
      // getNodeTris는 매번 새 IntArray 래퍼를 힙에 만든다 (0.44 생성기 누수 수정과 같이 푼다)
      const nodeTris = chunky.getNodeTris(nodeId);
      // 새 배열 (0으로 채워짐): markWalkableTriangles는 걷는 삼각형만 표시하고 나머지는 건드리지 않는다
      const areas = new TriangleAreasArray();
      areas.resize(nNodeTris);
      markWalkableTriangles(ctx, tc.walkableSlopeAngle, verts, nv, nodeTris, nNodeTris, areas);
      rasterizeTriangles(ctx, verts, nv, nodeTris, areas, nNodeTris, hf, tc.walkableClimb);
      areas.destroy();
      nodeTris.destroy();
    }
    filterLowHangingWalkableObstacles(ctx, tc.walkableClimb, hf);
    filterLedgeSpans(ctx, tc.walkableHeight, tc.walkableClimb, hf);
    filterWalkableLowHeightSpans(ctx, tc.walkableHeight, hf);
    const chf = allocCompactHeightfield();
    const okC = buildCompactHeightfield(ctx, tc.walkableHeight, tc.walkableClimb, hf, chf);
    freeHeightfield(hf);
    // 속이 찬 기둥 속 바닥을 지운다 (윗면은 남긴다: 윗면 아래 3칸까지만)
    if (okC) {
      for (const sd of this.solids) {
        if (sd.x1 < bmin[0] || sd.x0 > bmax[0] || sd.z1 < bmin[2] || sd.z0 > bmax[2]) continue;
        markConvexPolyArea(ctx, sd.verts, sd.n, sd.ymin - 0.1, sd.ymax - 3 * c.ch, 0, chf);
      }
    }
    if (!okC || !erodeWalkableArea(ctx, tc.walkableRadius, chf)) {
      freeCompactHeightfield(chf);
      Raw.destroy(tc);
      return out;
    }
    const lset = allocHeightfieldLayerSet();
    const okL = buildHeightfieldLayers(ctx, chf, tc.borderSize, tc.walkableHeight, lset);
    freeCompactHeightfield(chf);
    if (okL) {
      for (let i = 0; i < lset.nlayers(); i++) {
        const layer = lset.layers(i);
        const header = new Raw.dtTileCacheLayerHeader();
        header.magic = Detour.DT_TILECACHE_MAGIC;
        header.version = Detour.DT_TILECACHE_VERSION;
        header.tx = tx;
        header.ty = ty;
        header.tlayer = i;
        const lb = layer.bmin();
        const lB = layer.bmax();
        header.set_bmin(0, lb.x);
        header.set_bmin(1, lb.y);
        header.set_bmin(2, lb.z);
        header.set_bmax(0, lB.x);
        header.set_bmax(1, lB.y);
        header.set_bmax(2, lB.z);
        header.width = layer.width();
        header.height = layer.height();
        header.minx = layer.minx();
        header.maxx = layer.maxx();
        header.miny = layer.miny();
        header.maxy = layer.maxy();
        header.hmin = layer.hmin();
        header.hmax = layer.hmax();
        const data = new TileCacheData();
        // 층 배열 래퍼 셋도 부를 때마다 새로 생긴다 (압축은 data로 복사되므로 바로 푼다)
        const heights = getHeightfieldLayerHeights(layer);
        const lAreas = getHeightfieldLayerAreas(layer);
        const cons = getHeightfieldLayerCons(layer);
        const st = buildTileCacheLayer(this.compressor, header, heights, lAreas, cons, data);
        heights.destroy();
        lAreas.destroy();
        cons.destroy();
        Raw.destroy(header);
        if (!statusFailed(st)) out.push(data.toTypedArray());
        data.destroy();
      }
    }
    freeHeightfieldLayerSet(lset);
    Raw.destroy(tc);
    return out;
  }

  destroy(): void {
    for (const sd of this.solids) sd.verts.destroy();
    this.verts.destroy();
    this.tris.destroy();
    this.chunkIds.destroy();
    this.chunky.destroy();
    this.ctx.destroy();
    Raw.destroy(this.compressor);
    Raw.destroy(this.config);
  }
}

export interface AssembleResult {
  tileCache: TileCache;
  navMesh: NavMesh;
  /** 타일 캐시에 넣은 압축 데이터 (dispose 때 푼다) */
  datas: InstanceType<typeof TileCacheData>[];
  /** 타일 캐시가 쓰는 할당기·압축기·메시 처리기 (타일 캐시를 푼 뒤에 푼다) */
  owned: { destroy(): void }[];
  compressedBytes: number;
  layers: number;
  /** 타일 메시 만드는 데 든 시간 (ms, 양보 제외) */
  meshMs: number;
}

/** 압축 층 → TileCache + NavMesh. 링크는 타일을 다시 만들 때마다 붙는다 (links 배열을 바꾸면 다음 재생성부터) */
export async function assembleTileCache(
  c: BakeConfig,
  grid: BakeGrid,
  blobs: Uint8Array[],
  opts: { maxObstacles: number; links: OffMeshConnectionParams[]; yieldFn?: () => Promise<void> | void; onProgress?: (f: number) => void },
): Promise<AssembleResult> {
  const t0 = performance.now();
  const v = grid.voxels;
  const nLayers = Math.max(1, blobs.length);
  const tileCacheParams = DetourTileCacheParams.create({
    orig: c.bmin,
    cs: c.cs,
    ch: c.ch,
    width: c.tileSize,
    height: c.tileSize,
    walkableHeight: v.height * c.ch,
    walkableRadius: v.radius * c.cs,
    walkableClimb: v.climb * c.ch,
    maxSimplificationError: c.maxSimplificationError ?? 1.3,
    maxTiles: nLayers + 64,
    maxObstacles: opts.maxObstacles,
  });
  const links = opts.links;
  const tcsW = c.tileSize * c.cs;
  const mine: OffMeshConnectionParams[] = [];
  const meshProcess = new TileCacheMeshProcess((params, areas, flags) => {
    for (let i = 0; i < params.polyCount(); i++) {
      areas.set(i, 0);
      flags.set(i, POLY_WALK);
    }
    // 링크는 시작점이 이 타일에 있는 것만 넘긴다 (Detour도 그것만 타일에 넣는다). setOffMeshConnections가 C++ 배열을 새로 잡고
    // 타일 캐시는 그것을 풀지 않으므로, 모든 타일에 전부 넘기면 타일을 만들 때마다 링크 수만큼 샌다
    if (!links.length) return;
    const tx = params.tileX();
    const ty = params.tileY();
    mine.length = 0;
    for (const l of links) {
      if (Math.floor((l.startPosition.x - c.bmin[0]) / tcsW) === tx && Math.floor((l.startPosition.z - c.bmin[2]) / tcsW) === ty) mine.push(l);
    }
    if (mine.length) params.setOffMeshConnections(mine);
  });
  const tileCache = new TileCache();
  const allocator = new Raw.RecastLinearAllocator(64000);
  const compressor = new Raw.RecastFastLZCompressor();
  const inited = tileCache.init(tileCacheParams, allocator, compressor, meshProcess);
  // 설정은 init이 복사한다. 할당기·압축기·메시 처리기는 타일 캐시가 살아 있는 동안 쓰므로 dispose 때 함께 푼다 (datas 뒤에)
  Raw.destroy(tileCacheParams.raw);
  const owned = [
    { destroy: () => Raw.destroy(allocator) },
    { destroy: () => Raw.destroy(compressor) },
    { destroy: () => Raw.destroy(meshProcess.raw) },
  ];
  if (!inited) {
    tileCache.destroy();
    for (const o of owned) o.destroy();
    throw new Error('[nav] tile cache init 실패');
  }
  // 타일·폴리곤 비트 (32비트 참조: salt 10 + tile + poly = 22)
  const tileBits = Math.min(14, Math.max(1, Math.ceil(Math.log2(nLayers + 1))));
  const navMesh = new NavMesh();
  const tcs = c.tileSize * c.cs;
  const nmParams = NavMeshParams.create({
    orig: { x: c.bmin[0], y: c.bmin[1], z: c.bmin[2] },
    tileWidth: tcs,
    tileHeight: tcs,
    maxTiles: 1 << tileBits,
    maxPolys: 1 << (22 - tileBits),
  });
  const meshOk = navMesh.initTiled(nmParams);
  Raw.destroy(nmParams.raw);
  if (!meshOk) {
    tileCache.destroy();
    navMesh.destroy();
    for (const o of owned) o.destroy();
    throw new Error('[nav] navmesh init 실패');
  }
  if (blobs.length > 1 << tileBits) console.warn(`[nav] 층 ${blobs.length}개 > 내비메시 타일 한도 ${1 << tileBits}: tileSize를 키울 것`);
  const datas: InstanceType<typeof TileCacheData>[] = [];
  let bytes = 0;
  for (const b of blobs) {
    const d = new TileCacheData();
    d.copy(b);
    // 데이터는 우리가 갖고 있다가 dispose 때 푼다 (FREE_DATA 없이)
    const r = tileCache.addTile(d, 0);
    if (statusFailed(r.status)) {
      console.warn('[nav] addTile 실패', r.status);
      d.destroy();
      continue;
    }
    datas.push(d);
    bytes += b.length;
    if (opts.yieldFn) await opts.yieldFn();
  }
  let meshMs = performance.now() - t0;
  for (let y = 0; y < grid.tilesZ; y++) {
    for (let x = 0; x < grid.tilesX; x++) {
      const s = performance.now();
      tileCache.buildNavMeshTilesAt(x, y, navMesh);
      meshMs += performance.now() - s;
      // 타일마다 예산을 본다 (한 줄을 한 번에 만들면 큰 레벨은 30 ms 넘게 막혀, 연출 동안 미리 구울 때 화면이 끊겼다)
      if (opts.yieldFn) await opts.yieldFn();
    }
    opts.onProgress?.((y + 1) / grid.tilesZ);
  }
  return { tileCache, navMesh, datas, owned, compressedBytes: bytes, layers: datas.length, meshMs };
}

/** 워커에 보내는 굽기 요청 / 받는 결과 */
export interface BakeRequest {
  id: number;
  positions: Float32Array;
  indices: Uint32Array;
  config: BakeConfig;
  solids: SolidPrism[];
  /** [tx, ty, tx, ty, …] */
  tiles: Int32Array;
}

export interface BakeReply {
  id: number;
  blobs?: Uint8Array[];
  /** 일한 시간 (ms, WASM 준비 제외) */
  ms?: number;
  /** WASM 준비 시간 (ms) */
  initMs?: number;
  /** 굽고 난 뒤 이 워커의 WASM 힙 크기 (바이트) */
  heap?: number;
  error?: string;
}
