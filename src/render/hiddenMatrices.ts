import * as THREE from 'three';

/**
 * 숨은 물체의 행렬 갱신 건너뛰기 (렌더할 때만).
 * three의 scene.updateMatrixWorld는 보이지 않는 물체 아래까지 매 프레임 모든 행렬을 다시 계산한다. 아직 나오지 않은
 * 예비 캐릭터(숨은 인물 25명, 비행체 6대)만 2,600개가 넘어 렌더 행렬 갱신의 3할이었던 장면이 있다 (성능 조사).
 *
 * cullHiddenMatrices(o)를 건 물체는 렌더러가 장면 행렬을 갱신하는 동안(Engine.render) 숨어 있으면 그 아래를 건너뛴다.
 * 다시 보이면 그 프레임에 아래 전체를 다시 계산한다. 렌더 밖에서 직접 부르는 updateMatrixWorld·getWorldPosition은 그대로다.
 * 숨은 동안 matrixWorld를 갱신 없이 바로 읽는 코드만 영향을 받는다 (캐릭터·움직이는 물체 뿌리에만 건다).
 */
let sceneUpdate = false;

/** Engine.render가 월드 씬을 그리는 동안 켠다 */
export function setSceneMatrixUpdate(on: boolean): void {
  sceneUpdate = on;
}

export function cullHiddenMatrices(o: THREE.Object3D): void {
  if (o.userData.__cullHidden) return;
  o.userData.__cullHidden = true;
  const own = o.updateMatrixWorld;
  o.updateMatrixWorld = function (this: THREE.Object3D, force?: boolean): void {
    if (sceneUpdate && !this.visible) {
      // 부모가 움직였으면 보일 때 다시 계산하도록 표시만 해 둔다
      if (force) this.matrixWorldNeedsUpdate = true;
      return;
    }
    own.call(this, force);
  };
}
