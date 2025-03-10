import { clamp } from '../../../Util';
import { UncompressedSplatArray } from '../../UncompressedSplatArray';
import * as THREE from 'three';

import { getGPUTier } from 'detect-gpu';

export class GLTFParser {
  constructor() {}

  async decodeSplatData(splatCount, splatBuffers, shBuffers) {
    const gpuTier = await getGPUTier();

    // Mobile devices will not show spherical harmonics for now.
    let degree = 0;

    // Desktop can either show 1 or 2 harmonic degrees depending on
    // the hardware present.
    if (!gpuTier.isMobile) {
      switch (gpuTier.tier) {
        case 2:
          degree = 1;
          break;
        case 3:
          degree = 2;
          break;
      }
    }
    const shDegree = degree;

    console.log('the degree is : ' + degree);

    const splatArray = new UncompressedSplatArray(shDegree);

    for (let row = 0; row < splatCount; row++) {
      const newSplat = GLTFParser.parseToUncompressedSplat(
        splatBuffers,
        row,
        shBuffers,
        shDegree,
      );
      splatArray.addSplat(newSplat);
    }
    return splatArray;
  }

  static parseToUncompressedSplat = (function() {
    const tempRotation = new THREE.Quaternion();

    const OFFSET = UncompressedSplatArray.OFFSET;

    const SH_C0 = 0.28209479177387814;

    return function(splatBuffers, row, shBuffers, shDegree) {
      const newSplat = UncompressedSplatArray.createSplat(0);

      // center
      const positions = splatBuffers.POSITION;

      const x = positions[row * 3];
      const y = positions[row * 3 + 1];
      const z = positions[row * 3 + 2];

      newSplat[OFFSET.X] = x;
      newSplat[OFFSET.Y] = y;
      newSplat[OFFSET.Z] = z;

      // scale
      const scales = splatBuffers.scale;

      const sx = Math.exp(scales[row * 3]);
      const sy = Math.exp(scales[row * 3 + 1]);
      const sz = Math.exp(scales[row * 3 + 2]);

      newSplat[OFFSET.SCALE0] = sx;
      newSplat[OFFSET.SCALE1] = sy;
      newSplat[OFFSET.SCALE2] = sz;

      // rotation
      const rotations = splatBuffers.rotation;
      const rx = rotations[row * 4];
      const ry = rotations[row * 4 + 1];
      const rz = rotations[row * 4 + 2];
      const rw = rotations[row * 4 + 3];

      tempRotation.set(rx, ry, rz, rw);
      tempRotation.normalize();

      newSplat[OFFSET.ROTATION0] = tempRotation.x;
      newSplat[OFFSET.ROTATION1] = tempRotation.y;
      newSplat[OFFSET.ROTATION2] = tempRotation.z;
      newSplat[OFFSET.ROTATION3] = tempRotation.w;

      // opacity
      const opacities = splatBuffers.opacity;
      const sh0 = splatBuffers.sh_band_0;

      const opacity = (1 / (1 + Math.exp(-opacities[row]))) * 255;
      newSplat[OFFSET.OPACITY] = clamp(Math.floor(opacity), 0, 255);

      // base color aka. sh degree 0
      const dcx = sh0[row * 3];
      const dcy = sh0[row * 3 + 1];
      const dcz = sh0[row * 3 + 2];

      newSplat[OFFSET.FDC0] = (0.5 + SH_C0 * dcx) * 255;
      newSplat[OFFSET.FDC1] = (0.5 + SH_C0 * dcy) * 255;
      newSplat[OFFSET.FDC2] = (0.5 + SH_C0 * dcz) * 255;

      newSplat[OFFSET.FDC0] = clamp(Math.floor(newSplat[OFFSET.FDC0]), 0, 255);
      newSplat[OFFSET.FDC1] = clamp(Math.floor(newSplat[OFFSET.FDC1]), 0, 255);
      newSplat[OFFSET.FDC2] = clamp(Math.floor(newSplat[OFFSET.FDC2]), 0, 255);

      // first order sh bands
      if (shDegree >= 1) {
        for (let i = 0; i < 3; i++) {
          newSplat[OFFSET[`FRC${0 + i}`]] = shBuffers.sh_band_1_0[row * 3 + i];
          newSplat[OFFSET[`FRC${3 + i}`]] = shBuffers.sh_band_1_1[row * 3 + i];
          newSplat[OFFSET[`FRC${6 + i}`]] = shBuffers.sh_band_1_2[row * 3 + i];
        }

        // second order sh bands
        if (shDegree >= 2) {
          for (let i = 0; i < 3; i++) {
            newSplat[OFFSET[`FRC${9 + i}`]] =
              shBuffers.sh_band_2_0[row * 3 + i];
            newSplat[OFFSET[`FRC${12 + i}`]] =
              shBuffers.sh_band_2_1[row * 3 + i];
            newSplat[OFFSET[`FRC${15 + i}`]] =
              shBuffers.sh_band_2_2[row * 3 + i];
            newSplat[OFFSET[`FRC${18 + i}`]] =
              shBuffers.sh_band_2_3[row * 3 + i];
            newSplat[OFFSET[`FRC${21 + i}`]] =
              shBuffers.sh_band_2_4[row * 3 + i];
          }
        }
      }

      return newSplat;
    };
  })();

  async parseToUncompressedSplatArray(splatCount, splatBuffers, shBuffers) {
    return await this.decodeSplatData(splatCount, splatBuffers, shBuffers);
  }
}
