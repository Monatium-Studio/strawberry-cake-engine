import * as THREE from 'three';

/**
 * 로그 깊이 버퍼(WebGLRenderer logarithmicDepthBuffer) 지원.
 * 내장 머티리얼은 three가 알아서 로그 깊이를 쓰지만, 직접 짠 ShaderMaterial은 gl_FragDepth를 같은 식으로 써야
 * 다른 물체와 깊이가 맞는다(안 쓰면 파티클·광륜이 엉뚱하게 가려지거나 비친다). 셰이더 문자열을 고쳐 넣는다.
 *   patchLogDepth(new THREE.ShaderMaterial({...}))
 * 전체 화면 사각형(깊이 검사 끔)에는 필요 없다.
 */
const VERT_PARS = '\n#ifdef USE_LOGDEPTHBUF\nvarying float vFragDepth;\n#endif\n';
const VERT_BODY = '\n#ifdef USE_LOGDEPTHBUF\nvFragDepth = 1.0 + gl_Position.w;\n#endif\n';
const FRAG_PARS = '\n#ifdef USE_LOGDEPTHBUF\nuniform float logDepthBufFC;\nvarying float vFragDepth;\n#endif\n';
const FRAG_BODY = '\n#ifdef USE_LOGDEPTHBUF\ngl_FragDepth = log2( vFragDepth ) * logDepthBufFC * 0.5;\n#endif\n';

export function patchLogDepth<T extends THREE.ShaderMaterial>(mat: T): T {
  if (mat.userData.logDepthPatched) return mat;
  let vs = mat.vertexShader;
  let fs = mat.fragmentShader;
  const vMain = vs.search(/void\s+main\s*\(\s*\)/);
  const fMain = fs.search(/void\s+main\s*\(\s*\)/);
  if (vMain < 0 || fMain < 0) return mat;
  vs = vs.slice(0, vMain) + VERT_PARS + vs.slice(vMain);
  // 마지막 gl_Position 대입 뒤에 넣는다
  const re = /gl_Position\s*=[^;]*;/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(vs); m; m = re.exec(vs)) last = m;
  if (!last) return mat;
  const at = last.index + last[0].length;
  vs = vs.slice(0, at) + VERT_BODY + vs.slice(at);
  fs = fs.slice(0, fMain) + FRAG_PARS + fs.slice(fMain);
  const open = fs.indexOf('{', fs.search(/void\s+main\s*\(\s*\)/));
  fs = fs.slice(0, open + 1) + FRAG_BODY + fs.slice(open + 1);
  mat.vertexShader = vs;
  mat.fragmentShader = fs;
  mat.userData.logDepthPatched = true;
  mat.needsUpdate = true;
  return mat;
}
