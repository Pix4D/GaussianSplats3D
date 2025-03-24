import * as THREE from 'three';
import { UncompressedSplatArray } from './UncompressedSplatArray.js';
import {
  clamp,
  getSphericalHarmonicsComponentCountForDegree,
} from '../Util.js';
import { Constants } from '../Constants.js';

const DefaultSphericalHarmonics8BitCompressionRange =
  Constants.SphericalHarmonics8BitCompressionRange;
const DefaultSphericalHarmonics8BitCompressionHalfRange =
  DefaultSphericalHarmonics8BitCompressionRange / 2.0;

const toHalfFloat = THREE.DataUtils.toHalfFloat.bind(THREE.DataUtils);
const fromHalfFloat = THREE.DataUtils.fromHalfFloat.bind(THREE.DataUtils);

const toUncompressedFloat = (
  f,
  compressionLevel,
  isSH = false,
  range8BitMin,
  range8BitMax,
) => {
  if (compressionLevel === 0) {
    return f;
  } else if (compressionLevel === 1 || (compressionLevel === 2 && !isSH)) {
    return THREE.DataUtils.fromHalfFloat(f);
  } else if (compressionLevel === 2) {
    return fromUint8(f, range8BitMin, range8BitMax);
  }
};

const toUint8 = (v, rangeMin, rangeMax) => {
  v = clamp(v, rangeMin, rangeMax);
  const range = rangeMax - rangeMin;
  return clamp(Math.floor(((v - rangeMin) / range) * 255), 0, 255);
};

const fromUint8 = (v, rangeMin, rangeMax) => {
  const range = rangeMax - rangeMin;
  return (v / 255) * range + rangeMin;
};

const fromHalfFloatToUint8 = (v, rangeMin, rangeMax) => {
  return toUint8(fromHalfFloat(v, rangeMin, rangeMax));
};

const fromUint8ToHalfFloat = (v, rangeMin, rangeMax) => {
  return toHalfFloat(fromUint8(v, rangeMin, rangeMax));
};

const dataViewFloatForCompressionLevel = (
  dataView,
  floatIndex,
  compressionLevel,
  isSH = false,
) => {
  if (compressionLevel === 0) {
    return dataView.getFloat32(floatIndex * 4, true);
  } else if (compressionLevel === 1 || (compressionLevel === 2 && !isSH)) {
    return dataView.getUint16(floatIndex * 2, true);
  } else {
    return dataView.getUint8(floatIndex, true);
  }
};

const convertBetweenCompressionLevels = (function() {
  const noop = (v) => v;

  return function(val, fromLevel, toLevel, isSH = false) {
    if (fromLevel === toLevel) return val;
    let outputConversionFunc = noop;

    if (fromLevel === 2 && isSH) {
      if (toLevel === 1) outputConversionFunc = fromUint8ToHalfFloat;
      else if (toLevel == 0) {
        outputConversionFunc = fromUint8;
      }
    } else if (fromLevel === 2 || fromLevel === 1) {
      if (toLevel === 0) outputConversionFunc = fromHalfFloat;
      else if (toLevel == 2) {
        if (!isSH) outputConversionFunc = noop;
        else outputConversionFunc = fromHalfFloatToUint8;
      }
    } else if (fromLevel === 0) {
      if (toLevel === 1) outputConversionFunc = toHalfFloat;
      else if (toLevel == 2) {
        if (!isSH) outputConversionFunc = toHalfFloat;
        else outputConversionFunc = toUint8;
      }
    }

    return outputConversionFunc(val);
  };
})();

const copyBetweenBuffers = (
  srcBuffer,
  srcOffset,
  destBuffer,
  destOffset,
  byteCount = 0,
) => {
  const src = new Uint8Array(srcBuffer, srcOffset);
  const dest = new Uint8Array(destBuffer, destOffset);
  for (let i = 0; i < byteCount; i++) {
    dest[i] = src[i];
  }
};

/**
 * SplatBuffer: Container for splat data from a single scene/file and capable of (mediocre) compression.
 */
export class SplatBuffer {
  static CurrentMajorVersion = 0;
  static CurrentMinorVersion = 1;

  static CenterComponentCount = 3;
  static ScaleComponentCount = 3;
  static RotationComponentCount = 4;
  static ColorComponentCount = 4;
  static CovarianceComponentCount = 6;

  static SplatScaleOffsetFloat = 3;
  static SplatRotationOffsetFloat = 6;

  static CompressionLevels = {
    0: {
      BytesPerCenter: 12,
      BytesPerScale: 12,
      BytesPerRotation: 16,
      BytesPerColor: 4,
      ScaleOffsetBytes: 12,
      RotationffsetBytes: 24,
      ColorOffsetBytes: 40,
      SphericalHarmonicsOffsetBytes: 44,
      ScaleRange: 1,
      BytesPerSphericalHarmonicsComponent: 4,
      SphericalHarmonicsOffsetFloat: 11,
      SphericalHarmonicsDegrees: {
        0: { BytesPerSplat: 44 },
        1: { BytesPerSplat: 80 },
        2: { BytesPerSplat: 140 },
        3: { BytesPerSplat: 236 },
      },
    },
    1: {
      BytesPerCenter: 6,
      BytesPerScale: 6,
      BytesPerRotation: 8,
      BytesPerColor: 4,
      ScaleOffsetBytes: 6,
      RotationffsetBytes: 12,
      ColorOffsetBytes: 20,
      SphericalHarmonicsOffsetBytes: 24,
      ScaleRange: 32767,
      BytesPerSphericalHarmonicsComponent: 2,
      SphericalHarmonicsOffsetFloat: 12,
      SphericalHarmonicsDegrees: {
        0: { BytesPerSplat: 24 },
        1: { BytesPerSplat: 42 },
        2: { BytesPerSplat: 72 },
        3: { BytesPerSplat: 114 },
      },
    },
    2: {
      BytesPerCenter: 6,
      BytesPerScale: 6,
      BytesPerRotation: 8,
      BytesPerColor: 4,
      ScaleOffsetBytes: 6,
      RotationffsetBytes: 12,
      ColorOffsetBytes: 20,
      SphericalHarmonicsOffsetBytes: 24,
      ScaleRange: 32767,
      BytesPerSphericalHarmonicsComponent: 1,
      SphericalHarmonicsOffsetFloat: 12,
      SphericalHarmonicsDegrees: {
        0: { BytesPerSplat: 24 },
        1: { BytesPerSplat: 33 },
        2: { BytesPerSplat: 48 },
        3: { BytesPerSplat: 69 },
      },
    },
  };

  static CovarianceSizeFloats = 6;

  static HeaderSizeBytes = 4096;
  static SectionHeaderSizeBytes = 1024;

  static BucketStorageSizeBytes = 12;
  static BucketStorageSizeFloats = 3;

  static BucketBlockSize = 5.0;
  static BucketSize = 256;

  constructor(bufferData, secLoadedCountsToMax = true) {
    this.constructFromBuffer(bufferData, secLoadedCountsToMax);
  }

  getSplatCount() {
    return this.splatCount;
  }

  getMaxSplatCount() {
    return this.maxSplatCount;
  }

  getMinSphericalHarmonicsDegree() {
    let minSphericalHarmonicsDegree = 0;
    for (let i = 0; i < this.sections.length; i++) {
      const section = this.sections[i];
      if (
        i === 0 ||
        section.sphericalHarmonicsDegree < minSphericalHarmonicsDegree
      ) {
        minSphericalHarmonicsDegree = section.sphericalHarmonicsDegree;
      }
    }
    return minSphericalHarmonicsDegree;
  }

  getBucketIndex(section, localSplatIndex) {
    let bucketIndex;
    const maxSplatIndexInFullBuckets =
      section.fullBucketCount * section.bucketSize;
    if (localSplatIndex < maxSplatIndexInFullBuckets) {
      bucketIndex = Math.floor(localSplatIndex / section.bucketSize);
    } else {
      let bucketSplatIndex = maxSplatIndexInFullBuckets;
      bucketIndex = section.fullBucketCount;
      let partiallyFullBucketIndex = 0;
      while (bucketSplatIndex < section.splatCount) {
        let currentPartiallyFilledBucketSize =
          section.partiallyFilledBucketLengths[partiallyFullBucketIndex];
        if (
          localSplatIndex >= bucketSplatIndex &&
          localSplatIndex < bucketSplatIndex + currentPartiallyFilledBucketSize
        ) {
          break;
        }
        bucketSplatIndex += currentPartiallyFilledBucketSize;
        bucketIndex++;
        partiallyFullBucketIndex++;
      }
    }
    return bucketIndex;
  }

  getSplatCenter(globalSplatIndex, outCenter, transform) {
    const sectionIndex = this.globalSplatIndexToSectionMap[globalSplatIndex];
    const section = this.sections[sectionIndex];
    const localSplatIndex = globalSplatIndex - section.splatCountOffset;

    const srcSplatCentersBase = section.bytesPerSplat * localSplatIndex;
    const dataView = new DataView(
      this.bufferData,
      section.dataBase + srcSplatCentersBase,
    );

    const x = dataViewFloatForCompressionLevel(
      dataView,
      0,
      this.compressionLevel,
    );
    const y = dataViewFloatForCompressionLevel(
      dataView,
      1,
      this.compressionLevel,
    );
    const z = dataViewFloatForCompressionLevel(
      dataView,
      2,
      this.compressionLevel,
    );
    if (this.compressionLevel >= 1) {
      const bucketIndex = this.getBucketIndex(section, localSplatIndex);
      const bucketBase = bucketIndex * SplatBuffer.BucketStorageSizeFloats;
      const sf = section.compressionScaleFactor;
      const sr = section.compressionScaleRange;
      outCenter.x = (x - sr) * sf + section.bucketArray[bucketBase];
      outCenter.y = (y - sr) * sf + section.bucketArray[bucketBase + 1];
      outCenter.z = (z - sr) * sf + section.bucketArray[bucketBase + 2];
    } else {
      outCenter.x = x;
      outCenter.y = y;
      outCenter.z = z;
    }
    if (transform) outCenter.applyMatrix4(transform);
  }

  getSplatScaleAndRotation = (function() {
    const scaleMatrix = new THREE.Matrix4();
    const rotationMatrix = new THREE.Matrix4();
    const tempMatrix = new THREE.Matrix4();
    const tempPosition = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();

    return function(index, outScale, outRotation, transform, scaleOverride) {
      const sectionIndex = this.globalSplatIndexToSectionMap[index];
      const section = this.sections[sectionIndex];
      const localSplatIndex = index - section.splatCountOffset;

      const srcSplatScalesBase =
        section.bytesPerSplat * localSplatIndex +
        SplatBuffer.CompressionLevels[this.compressionLevel].ScaleOffsetBytes;

      const dataView = new DataView(
        this.bufferData,
        section.dataBase + srcSplatScalesBase,
      );

      scale.set(
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 0, this.compressionLevel),
          this.compressionLevel,
        ),
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 1, this.compressionLevel),
          this.compressionLevel,
        ),
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 2, this.compressionLevel),
          this.compressionLevel,
        ),
      );
      if (scaleOverride) {
        if (scaleOverride.x !== undefined) scale.x = scaleOverride.x;
        if (scaleOverride.y !== undefined) scale.y = scaleOverride.y;
        if (scaleOverride.z !== undefined) scale.z = scaleOverride.z;
      }

      rotation.set(
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 4, this.compressionLevel),
          this.compressionLevel,
        ),
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 5, this.compressionLevel),
          this.compressionLevel,
        ),
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 6, this.compressionLevel),
          this.compressionLevel,
        ),
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 3, this.compressionLevel),
          this.compressionLevel,
        ),
      );

      if (transform) {
        scaleMatrix.makeScale(scale.x, scale.y, scale.z);
        rotationMatrix.makeRotationFromQuaternion(rotation);
        tempMatrix
          .copy(scaleMatrix)
          .multiply(rotationMatrix)
          .multiply(transform);
        tempMatrix.decompose(tempPosition, outRotation, outScale);
      } else {
        outScale.copy(scale);
        outRotation.copy(rotation);
      }
    };
  })();

  getSplatColor(globalSplatIndex, outColor) {
    const sectionIndex = this.globalSplatIndexToSectionMap[globalSplatIndex];
    const section = this.sections[sectionIndex];
    const localSplatIndex = globalSplatIndex - section.splatCountOffset;

    const srcSplatColorsBase =
      section.bytesPerSplat * localSplatIndex +
      SplatBuffer.CompressionLevels[this.compressionLevel].ColorOffsetBytes;
    const splatColorsArray = new Uint8Array(
      this.bufferData,
      section.dataBase + srcSplatColorsBase,
      4,
    );

    outColor.set(
      splatColorsArray[0],
      splatColorsArray[1],
      splatColorsArray[2],
      splatColorsArray[3],
    );
  }
  getSplatHarmonics(globalSplatIndex) {
    const sectionIndex = this.globalSplatIndexToSectionMap[globalSplatIndex];
    const section = this.sections[sectionIndex];
    const localSplatIndex = globalSplatIndex - section.splatCountOffset;

    const srcSplatHarmonicsBase =
      section.bytesPerSplat * localSplatIndex +
      SplatBuffer.CompressionLevels[this.compressionLevel]
        .SphericalHarmonicsOffsetBytes;

    return new Float32Array(
      this.bufferData,
      section.dataBase + srcSplatHarmonicsBase,
      45,
    );
  }

  fillSplatCenterArray(outCenterArray, transform, srcFrom, srcTo, destFrom) {
    const splatCount = this.splatCount;

    srcFrom = srcFrom || 0;
    srcTo = srcTo || splatCount - 1;
    if (destFrom === undefined) destFrom = srcFrom;

    const center = new THREE.Vector3();
    for (let i = srcFrom; i <= srcTo; i++) {
      const sectionIndex = this.globalSplatIndexToSectionMap[i];
      const section = this.sections[sectionIndex];
      const localSplatIndex = i - section.splatCountOffset;
      const centerDestBase =
        (i - srcFrom + destFrom) * SplatBuffer.CenterComponentCount;

      const srcSplatCentersBase = section.bytesPerSplat * localSplatIndex;
      const dataView = new DataView(
        this.bufferData,
        section.dataBase + srcSplatCentersBase,
      );

      const x = dataViewFloatForCompressionLevel(
        dataView,
        0,
        this.compressionLevel,
      );
      const y = dataViewFloatForCompressionLevel(
        dataView,
        1,
        this.compressionLevel,
      );
      const z = dataViewFloatForCompressionLevel(
        dataView,
        2,
        this.compressionLevel,
      );
      if (this.compressionLevel >= 1) {
        const bucketIndex = this.getBucketIndex(section, localSplatIndex);
        const bucketBase = bucketIndex * SplatBuffer.BucketStorageSizeFloats;
        const sf = section.compressionScaleFactor;
        const sr = section.compressionScaleRange;
        center.x = (x - sr) * sf + section.bucketArray[bucketBase];
        center.y = (y - sr) * sf + section.bucketArray[bucketBase + 1];
        center.z = (z - sr) * sf + section.bucketArray[bucketBase + 2];
      } else {
        center.x = x;
        center.y = y;
        center.z = z;
      }
      if (transform) {
        center.applyMatrix4(transform);
      }
      outCenterArray[centerDestBase] = center.x;
      outCenterArray[centerDestBase + 1] = center.y;
      outCenterArray[centerDestBase + 2] = center.z;
    }
  }

  fillSplatScaleRotationArray = (function() {
    const scaleMatrix = new THREE.Matrix4();
    const rotationMatrix = new THREE.Matrix4();
    const tempMatrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const tempPosition = new THREE.Vector3();

    const ensurePositiveW = (quaternion) => {
      const flip = quaternion.w < 0 ? -1 : 1;
      quaternion.x *= flip;
      quaternion.y *= flip;
      quaternion.z *= flip;
      quaternion.w *= flip;
    };

    return function(
      outScaleArray,
      outRotationArray,
      transform,
      srcFrom,
      srcTo,
      destFrom,
      desiredOutputCompressionLevel,
      scaleOverride,
    ) {
      const splatCount = this.splatCount;

      srcFrom = srcFrom || 0;
      srcTo = srcTo || splatCount - 1;
      if (destFrom === undefined) destFrom = srcFrom;

      const outputConversion = (value, srcCompressionLevel) => {
        if (srcCompressionLevel === undefined) {
          srcCompressionLevel = this.compressionLevel;
        }
        return convertBetweenCompressionLevels(
          value,
          srcCompressionLevel,
          desiredOutputCompressionLevel,
        );
      };

      for (let i = srcFrom; i <= srcTo; i++) {
        const sectionIndex = this.globalSplatIndexToSectionMap[i];
        const section = this.sections[sectionIndex];
        const localSplatIndex = i - section.splatCountOffset;

        const srcSplatScalesBase =
          section.bytesPerSplat * localSplatIndex +
          SplatBuffer.CompressionLevels[this.compressionLevel].ScaleOffsetBytes;

        const scaleDestBase =
          (i - srcFrom + destFrom) * SplatBuffer.ScaleComponentCount;
        const rotationDestBase =
          (i - srcFrom + destFrom) * SplatBuffer.RotationComponentCount;
        const dataView = new DataView(
          this.bufferData,
          section.dataBase + srcSplatScalesBase,
        );

        const srcScaleX =
          scaleOverride && scaleOverride.x !== undefined ?
            scaleOverride.x :
            dataViewFloatForCompressionLevel(
                dataView,
                0,
                this.compressionLevel,
              );
        const srcScaleY =
          scaleOverride && scaleOverride.y !== undefined ?
            scaleOverride.y :
            dataViewFloatForCompressionLevel(
                dataView,
                1,
                this.compressionLevel,
              );
        const srcScaleZ =
          scaleOverride && scaleOverride.z !== undefined ?
            scaleOverride.z :
            dataViewFloatForCompressionLevel(
                dataView,
                2,
                this.compressionLevel,
              );

        const srcRotationW = dataViewFloatForCompressionLevel(
          dataView,
          3,
          this.compressionLevel,
        );
        const srcRotationX = dataViewFloatForCompressionLevel(
          dataView,
          4,
          this.compressionLevel,
        );
        const srcRotationY = dataViewFloatForCompressionLevel(
          dataView,
          5,
          this.compressionLevel,
        );
        const srcRotationZ = dataViewFloatForCompressionLevel(
          dataView,
          6,
          this.compressionLevel,
        );

        scale.set(
          toUncompressedFloat(srcScaleX, this.compressionLevel),
          toUncompressedFloat(srcScaleY, this.compressionLevel),
          toUncompressedFloat(srcScaleZ, this.compressionLevel),
        );

        rotation
          .set(
            toUncompressedFloat(srcRotationX, this.compressionLevel),
            toUncompressedFloat(srcRotationY, this.compressionLevel),
            toUncompressedFloat(srcRotationZ, this.compressionLevel),
            toUncompressedFloat(srcRotationW, this.compressionLevel),
          )
          .normalize();

        if (transform) {
          tempPosition.set(0, 0, 0);
          scaleMatrix.makeScale(scale.x, scale.y, scale.z);
          rotationMatrix.makeRotationFromQuaternion(rotation);
          tempMatrix
            .identity()
            .premultiply(scaleMatrix)
            .premultiply(rotationMatrix);
          tempMatrix.premultiply(transform);
          tempMatrix.decompose(tempPosition, rotation, scale);
          rotation.normalize();
        }

        ensurePositiveW(rotation);

        if (outScaleArray) {
          outScaleArray[scaleDestBase] = outputConversion(scale.x, 0);
          outScaleArray[scaleDestBase + 1] = outputConversion(scale.y, 0);
          outScaleArray[scaleDestBase + 2] = outputConversion(scale.z, 0);
        }

        if (outRotationArray) {
          outRotationArray[rotationDestBase] = outputConversion(rotation.x, 0);
          outRotationArray[rotationDestBase + 1] = outputConversion(
            rotation.y,
            0,
          );
          outRotationArray[rotationDestBase + 2] = outputConversion(
            rotation.z,
            0,
          );
          outRotationArray[rotationDestBase + 3] = outputConversion(
            rotation.w,
            0,
          );
        }
      }
    };
  })();

  static computeCovariance = (function() {
    const tempMatrix4 = new THREE.Matrix4();
    const scaleMatrix = new THREE.Matrix3();
    const rotationMatrix = new THREE.Matrix3();
    const covarianceMatrix = new THREE.Matrix3();
    const transformedCovariance = new THREE.Matrix3();
    const transform3x3 = new THREE.Matrix3();
    const transform3x3Transpose = new THREE.Matrix3();

    return function(
      scale,
      rotation,
      transform,
      outCovariance,
      outOffset = 0,
      desiredOutputCompressionLevel,
    ) {
      tempMatrix4.makeScale(scale.x, scale.y, scale.z);
      scaleMatrix.setFromMatrix4(tempMatrix4);

      tempMatrix4.makeRotationFromQuaternion(rotation);
      rotationMatrix.setFromMatrix4(tempMatrix4);

      covarianceMatrix.copy(rotationMatrix).multiply(scaleMatrix);
      transformedCovariance
        .copy(covarianceMatrix)
        .transpose()
        .premultiply(covarianceMatrix);

      if (transform) {
        transform3x3.setFromMatrix4(transform);
        transform3x3Transpose.copy(transform3x3).transpose();
        transformedCovariance.multiply(transform3x3Transpose);
        transformedCovariance.premultiply(transform3x3);
      }

      if (desiredOutputCompressionLevel >= 1) {
        outCovariance[outOffset] = toHalfFloat(
          transformedCovariance.elements[0],
        );
        outCovariance[outOffset + 1] = toHalfFloat(
          transformedCovariance.elements[3],
        );
        outCovariance[outOffset + 2] = toHalfFloat(
          transformedCovariance.elements[6],
        );
        outCovariance[outOffset + 3] = toHalfFloat(
          transformedCovariance.elements[4],
        );
        outCovariance[outOffset + 4] = toHalfFloat(
          transformedCovariance.elements[7],
        );
        outCovariance[outOffset + 5] = toHalfFloat(
          transformedCovariance.elements[8],
        );
      } else {
        outCovariance[outOffset] = transformedCovariance.elements[0];
        outCovariance[outOffset + 1] = transformedCovariance.elements[3];
        outCovariance[outOffset + 2] = transformedCovariance.elements[6];
        outCovariance[outOffset + 3] = transformedCovariance.elements[4];
        outCovariance[outOffset + 4] = transformedCovariance.elements[7];
        outCovariance[outOffset + 5] = transformedCovariance.elements[8];
      }
    };
  })();

  fillSplatCovarianceArray(
    covarianceArray,
    transform,
    srcFrom,
    srcTo,
    destFrom,
    desiredOutputCompressionLevel,
  ) {
    const splatCount = this.splatCount;

    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();

    srcFrom = srcFrom || 0;
    srcTo = srcTo || splatCount - 1;
    if (destFrom === undefined) destFrom = srcFrom;

    for (let i = srcFrom; i <= srcTo; i++) {
      const sectionIndex = this.globalSplatIndexToSectionMap[i];
      const section = this.sections[sectionIndex];
      const localSplatIndex = i - section.splatCountOffset;

      const covarianceDestBase =
        (i - srcFrom + destFrom) * SplatBuffer.CovarianceComponentCount;
      const srcSplatScalesBase =
        section.bytesPerSplat * localSplatIndex +
        SplatBuffer.CompressionLevels[this.compressionLevel].ScaleOffsetBytes;

      const dataView = new DataView(
        this.bufferData,
        section.dataBase + srcSplatScalesBase,
      );

      scale.set(
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 0, this.compressionLevel),
          this.compressionLevel,
        ),
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 1, this.compressionLevel),
          this.compressionLevel,
        ),
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 2, this.compressionLevel),
          this.compressionLevel,
        ),
      );

      rotation.set(
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 4, this.compressionLevel),
          this.compressionLevel,
        ),
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 5, this.compressionLevel),
          this.compressionLevel,
        ),
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 6, this.compressionLevel),
          this.compressionLevel,
        ),
        toUncompressedFloat(
          dataViewFloatForCompressionLevel(dataView, 3, this.compressionLevel),
          this.compressionLevel,
        ),
      );

      SplatBuffer.computeCovariance(
        scale,
        rotation,
        transform,
        covarianceArray,
        covarianceDestBase,
        desiredOutputCompressionLevel,
      );
    }
  }

  fillSplatColorArray(outColorArray, minimumAlpha, srcFrom, srcTo, destFrom) {
    const splatCount = this.splatCount;

    srcFrom = srcFrom || 0;
    srcTo = srcTo || splatCount - 1;
    if (destFrom === undefined) destFrom = srcFrom;

    for (let i = srcFrom; i <= srcTo; i++) {
      const sectionIndex = this.globalSplatIndexToSectionMap[i];
      const section = this.sections[sectionIndex];
      const localSplatIndex = i - section.splatCountOffset;

      const colorDestBase =
        (i - srcFrom + destFrom) * SplatBuffer.ColorComponentCount;
      const srcSplatColorsBase =
        section.bytesPerSplat * localSplatIndex +
        SplatBuffer.CompressionLevels[this.compressionLevel].ColorOffsetBytes;

      const dataView = new Uint8Array(
        this.bufferData,
        section.dataBase + srcSplatColorsBase,
      );

      let alpha = dataView[3];
      alpha = alpha >= minimumAlpha ? alpha : 0;

      outColorArray[colorDestBase] = dataView[0];
      outColorArray[colorDestBase + 1] = dataView[1];
      outColorArray[colorDestBase + 2] = dataView[2];
      outColorArray[colorDestBase + 3] = alpha;
    }
  }

  fillSphericalHarmonicsArray = (function() {
    const sphericalHarmonicVectors = [];
    for (let i = 0; i < 15; i++) {
      sphericalHarmonicVectors[i] = new THREE.Vector3();
    }

    const tempMatrix3 = new THREE.Matrix3();
    const tempMatrix4 = new THREE.Matrix4();

    const tempTranslation = new THREE.Vector3();
    const tempScale = new THREE.Vector3();
    const tempRotation = new THREE.Quaternion();

    const sh11 = [];
    const sh12 = [];
    const sh13 = [];

    const shOut1 = [];
    const shOut2 = [];
    const shOut3 = [];

    // For the second degree
    const shOut21 = [];
    const shOut22 = [];
    const shOut23 = [];
    const shOut24 = [];
    const shOut25 = [];

    // For the third degree
    const shOut31 = [];
    const shOut32 = [];
    const shOut33 = [];
    const shOut34 = [];
    const shOut35 = [];
    const shOut36 = [];
    const shOut37 = [];

    const noop = (v) => v;

    const set3 = (array, val1, val2, val3) => {
      array[0] = val1;
      array[1] = val2;
      array[2] = val3;
    };

    const set3FromArray = (
      array,
      srcDestView,
      stride,
      srcBase,
      compressionLevel,
    ) => {
      array[0] = dataViewFloatForCompressionLevel(
        srcDestView,
        srcBase,
        compressionLevel,
        true,
      );
      array[1] = dataViewFloatForCompressionLevel(
        srcDestView,
        srcBase + stride,
        compressionLevel,
        true,
      );
      array[2] = dataViewFloatForCompressionLevel(
        srcDestView,
        srcBase + stride + stride,
        compressionLevel,
        true,
      );
    };

    const setOutput3 = (srcArray, destArray, destBase, conversionFunc) => {
      destArray[destBase] = conversionFunc(srcArray[0]);
      destArray[destBase + 1] = conversionFunc(srcArray[1]);
      destArray[destBase + 2] = conversionFunc(srcArray[2]);
    };

    return function(
      outSphericalHarmonicsArray,
      outSphericalHarmonicsDegree,
      transform,
      srcFrom,
      srcTo,
      destFrom,
      desiredOutputCompressionLevel,
    ) {
      const splatCount = this.splatCount;

      srcFrom = srcFrom || 0;
      srcTo = srcTo || splatCount - 1;
      if (destFrom === undefined) destFrom = srcFrom;

      if (transform && outSphericalHarmonicsDegree >= 1) {
        tempMatrix4.copy(transform);
        tempMatrix4.decompose(tempTranslation, tempRotation, tempScale);
        tempRotation.normalize();
        tempMatrix4.makeRotationFromQuaternion(tempRotation);
        tempMatrix3.setFromMatrix4(tempMatrix4);
        set3(
          sh11,
          tempMatrix3.elements[4],
          -tempMatrix3.elements[7],
          tempMatrix3.elements[1],
        );
        set3(
          sh12,
          -tempMatrix3.elements[5],
          tempMatrix3.elements[8],
          -tempMatrix3.elements[2],
        );
        set3(
          sh13,
          tempMatrix3.elements[3],
          -tempMatrix3.elements[6],
          tempMatrix3.elements[0],
        );
      }

      const localFromHalfFloatToUint8 = (v) => {
        return fromHalfFloatToUint8(
          v,
          this.minSphericalHarmonicsCoeff,
          this.maxSphericalHarmonicsCoeff,
        );
      };

      const localToUint8 = (v) => {
        return toUint8(
          v,
          this.minSphericalHarmonicsCoeff,
          this.maxSphericalHarmonicsCoeff,
        );
      };

      for (let i = srcFrom; i <= srcTo; i++) {
        const sectionIndex = this.globalSplatIndexToSectionMap[i];
        const section = this.sections[sectionIndex];
        outSphericalHarmonicsDegree = Math.min(
          outSphericalHarmonicsDegree,
          section.sphericalHarmonicsDegree,
        );
        const outSphericalHarmonicsComponentsCount =
          getSphericalHarmonicsComponentCountForDegree(
            outSphericalHarmonicsDegree,
          );

        const localSplatIndex = i - section.splatCountOffset;

        const srcSplatSHBase =
          section.bytesPerSplat * localSplatIndex +
          SplatBuffer.CompressionLevels[this.compressionLevel]
            .SphericalHarmonicsOffsetBytes;

        const dataView = new DataView(
          this.bufferData,
          section.dataBase + srcSplatSHBase,
        );

        const shDestBase =
          (i - srcFrom + destFrom) * outSphericalHarmonicsComponentsCount;

        let compressionLevelForOutputConversion = transform ?
          0 :
          this.compressionLevel;
        let outputConversionFunc = noop;
        if (
          compressionLevelForOutputConversion !== desiredOutputCompressionLevel
        ) {
          if (compressionLevelForOutputConversion === 1) {
            if (desiredOutputCompressionLevel === 0) {
              outputConversionFunc = fromHalfFloat;
            } else if (desiredOutputCompressionLevel == 2) {
              outputConversionFunc = localFromHalfFloatToUint8;
            }
          } else if (compressionLevelForOutputConversion === 0) {
            if (desiredOutputCompressionLevel === 1) {
              outputConversionFunc = toHalfFloat;
            } else if (desiredOutputCompressionLevel == 2) {
              outputConversionFunc = localToUint8;
            }
          }
        }

        const minShCoeff = this.minSphericalHarmonicsCoeff;
        const maxShCoeff = this.maxSphericalHarmonicsCoeff;
        const scale = Math.max(Math.abs(minShCoeff), Math.abs(maxShCoeff));

        const toUintMax = (v, Max) => {
          v = clamp(v / scale, -1, 1);
          v = 0.5 * v + 0.5;
          return clamp(Math.floor(v * Max), 0, Max);
        };

        // 111011 compression, 11 bits for red (2048)
        // 10 bits for green (1024)
        // 11 bits for blue (2048)
        const toUintMaxArray = (v) => {
          v[0] = toUintMax(v[0], 2047);
          v[1] = toUintMax(v[1], 1023);
          v[2] = toUintMax(v[2], 2047);
        };

        if (outSphericalHarmonicsDegree >= 1) {
          set3FromArray(shOut1, dataView, 1, 0, this.compressionLevel);
          set3FromArray(shOut2, dataView, 1, 3, this.compressionLevel);
          set3FromArray(shOut3, dataView, 1, 6, this.compressionLevel);
          toUintMaxArray(shOut1);
          toUintMaxArray(shOut2);
          toUintMaxArray(shOut3);
          setOutput3(
            shOut1,
            outSphericalHarmonicsArray,
            shDestBase,
            outputConversionFunc,
          );
          setOutput3(
            shOut2,
            outSphericalHarmonicsArray,
            shDestBase + 3,
            outputConversionFunc,
          );
          setOutput3(
            shOut3,
            outSphericalHarmonicsArray,
            shDestBase + 6,
            outputConversionFunc,
          );

          if (outSphericalHarmonicsDegree >= 2) {
            set3FromArray(shOut21, dataView, 1, 9, this.compressionLevel);
            set3FromArray(shOut22, dataView, 1, 12, this.compressionLevel);
            set3FromArray(shOut23, dataView, 1, 15, this.compressionLevel);
            set3FromArray(shOut24, dataView, 1, 18, this.compressionLevel);
            set3FromArray(shOut25, dataView, 1, 21, this.compressionLevel);
            toUintMaxArray(shOut21);
            toUintMaxArray(shOut22);
            toUintMaxArray(shOut23);
            toUintMaxArray(shOut24);
            toUintMaxArray(shOut25);
            setOutput3(
              shOut21,
              outSphericalHarmonicsArray,
              shDestBase + 9,
              outputConversionFunc,
            );
            setOutput3(
              shOut22,
              outSphericalHarmonicsArray,
              shDestBase + 12,
              outputConversionFunc,
            );
            setOutput3(
              shOut23,
              outSphericalHarmonicsArray,
              shDestBase + 15,
              outputConversionFunc,
            );
            setOutput3(
              shOut24,
              outSphericalHarmonicsArray,
              shDestBase + 18,
              outputConversionFunc,
            );
            setOutput3(
              shOut25,
              outSphericalHarmonicsArray,
              shDestBase + 21,
              outputConversionFunc,
            );
          }
          // TODO: define rotations for the third degree
          if (outSphericalHarmonicsDegree >= 3) {
            set3FromArray(shOut31, dataView, 1, 24, this.compressionLevel);
            set3FromArray(shOut32, dataView, 1, 27, this.compressionLevel);
            set3FromArray(shOut33, dataView, 1, 30, this.compressionLevel);
            set3FromArray(shOut34, dataView, 1, 33, this.compressionLevel);
            set3FromArray(shOut35, dataView, 1, 36, this.compressionLevel);
            set3FromArray(shOut36, dataView, 1, 39, this.compressionLevel);
            set3FromArray(shOut37, dataView, 1, 42, this.compressionLevel);
            toUintMaxArray(shOut31);
            toUintMaxArray(shOut32);
            toUintMaxArray(shOut33);
            toUintMaxArray(shOut34);
            toUintMaxArray(shOut35);
            toUintMaxArray(shOut36);
            toUintMaxArray(shOut37);
            setOutput3(
              shOut31,
              outSphericalHarmonicsArray,
              shDestBase + 24,
              outputConversionFunc,
            );
            setOutput3(
              shOut32,
              outSphericalHarmonicsArray,
              shDestBase + 27,
              outputConversionFunc,
            );
            setOutput3(
              shOut33,
              outSphericalHarmonicsArray,
              shDestBase + 30,
              outputConversionFunc,
            );
            setOutput3(
              shOut34,
              outSphericalHarmonicsArray,
              shDestBase + 33,
              outputConversionFunc,
            );
            setOutput3(
              shOut35,
              outSphericalHarmonicsArray,
              shDestBase + 36,
              outputConversionFunc,
            );
            setOutput3(
              shOut36,
              outSphericalHarmonicsArray,
              shDestBase + 39,
              outputConversionFunc,
            );
            setOutput3(
              shOut37,
              outSphericalHarmonicsArray,
              shDestBase + 42,
              outputConversionFunc,
            );
          }
        }
      }
    };
  })();

  static parseHeader(buffer) {
    const headerArrayUint8 = new Uint8Array(
      buffer,
      0,
      SplatBuffer.HeaderSizeBytes,
    );
    const headerArrayUint16 = new Uint16Array(
      buffer,
      0,
      SplatBuffer.HeaderSizeBytes / 2,
    );
    const headerArrayUint32 = new Uint32Array(
      buffer,
      0,
      SplatBuffer.HeaderSizeBytes / 4,
    );
    const headerArrayFloat32 = new Float32Array(
      buffer,
      0,
      SplatBuffer.HeaderSizeBytes / 4,
    );
    const versionMajor = headerArrayUint8[0];
    const versionMinor = headerArrayUint8[1];
    const maxSectionCount = headerArrayUint32[1];
    const sectionCount = headerArrayUint32[2];
    const maxSplatCount = headerArrayUint32[3];
    const splatCount = headerArrayUint32[4];
    const compressionLevel = headerArrayUint16[10];
    const sceneCenter = new THREE.Vector3(
      headerArrayFloat32[6],
      headerArrayFloat32[7],
      headerArrayFloat32[8],
    );

    const minSphericalHarmonicsCoeff =
      headerArrayFloat32[9] ||
      -DefaultSphericalHarmonics8BitCompressionHalfRange;
    const maxSphericalHarmonicsCoeff =
      headerArrayFloat32[10] ||
      DefaultSphericalHarmonics8BitCompressionHalfRange;

    return {
      versionMajor,
      versionMinor,
      maxSectionCount,
      sectionCount,
      maxSplatCount,
      splatCount,
      compressionLevel,
      sceneCenter,
      minSphericalHarmonicsCoeff,
      maxSphericalHarmonicsCoeff,
    };
  }

  static writeHeaderCountsToBuffer(sectionCount, splatCount, buffer) {
    const headerArrayUint32 = new Uint32Array(
      buffer,
      0,
      SplatBuffer.HeaderSizeBytes / 4,
    );
    headerArrayUint32[2] = sectionCount;
    headerArrayUint32[4] = splatCount;
  }

  static writeHeaderToBuffer(header, buffer) {
    const headerArrayUint8 = new Uint8Array(
      buffer,
      0,
      SplatBuffer.HeaderSizeBytes,
    );
    const headerArrayUint16 = new Uint16Array(
      buffer,
      0,
      SplatBuffer.HeaderSizeBytes / 2,
    );
    const headerArrayUint32 = new Uint32Array(
      buffer,
      0,
      SplatBuffer.HeaderSizeBytes / 4,
    );
    const headerArrayFloat32 = new Float32Array(
      buffer,
      0,
      SplatBuffer.HeaderSizeBytes / 4,
    );
    headerArrayUint8[0] = header.versionMajor;
    headerArrayUint8[1] = header.versionMinor;
    headerArrayUint8[2] = 0; // unused for now
    headerArrayUint8[3] = 0; // unused for now
    headerArrayUint32[1] = header.maxSectionCount;
    headerArrayUint32[2] = header.sectionCount;
    headerArrayUint32[3] = header.maxSplatCount;
    headerArrayUint32[4] = header.splatCount;
    headerArrayUint16[10] = header.compressionLevel;
    headerArrayFloat32[6] = header.sceneCenter.x;
    headerArrayFloat32[7] = header.sceneCenter.y;
    headerArrayFloat32[8] = header.sceneCenter.z;
    headerArrayFloat32[9] =
      header.minSphericalHarmonicsCoeff ||
      -DefaultSphericalHarmonics8BitCompressionHalfRange;
    headerArrayFloat32[10] =
      header.maxSphericalHarmonicsCoeff ||
      DefaultSphericalHarmonics8BitCompressionHalfRange;
  }

  static parseSectionHeaders(header, buffer, offset = 0, secLoadedCountsToMax) {
    const compressionLevel = header.compressionLevel;

    const maxSectionCount = header.maxSectionCount;
    const sectionHeaderArrayUint16 = new Uint16Array(
      buffer,
      offset,
      (maxSectionCount * SplatBuffer.SectionHeaderSizeBytes) / 2,
    );
    const sectionHeaderArrayUint32 = new Uint32Array(
      buffer,
      offset,
      (maxSectionCount * SplatBuffer.SectionHeaderSizeBytes) / 4,
    );
    const sectionHeaderArrayFloat32 = new Float32Array(
      buffer,
      offset,
      (maxSectionCount * SplatBuffer.SectionHeaderSizeBytes) / 4,
    );

    const sectionHeaders = [];
    let sectionHeaderBase = 0;
    let sectionHeaderBaseUint16 = sectionHeaderBase / 2;
    let sectionHeaderBaseUint32 = sectionHeaderBase / 4;
    let sectionBase =
      SplatBuffer.HeaderSizeBytes +
      header.maxSectionCount * SplatBuffer.SectionHeaderSizeBytes;
    let splatCountOffset = 0;
    for (let i = 0; i < maxSectionCount; i++) {
      const maxSplatCount =
        sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 1];
      const bucketSize = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 2];
      const bucketCount = sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 3];
      const bucketBlockSize =
        sectionHeaderArrayFloat32[sectionHeaderBaseUint32 + 4];
      const halfBucketBlockSize = bucketBlockSize / 2.0;
      const bucketStorageSizeBytes =
        sectionHeaderArrayUint16[sectionHeaderBaseUint16 + 10];
      const compressionScaleRange =
        sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 6] ||
        SplatBuffer.CompressionLevels[compressionLevel].ScaleRange;
      const fullBucketCount =
        sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 8];
      const partiallyFilledBucketCount =
        sectionHeaderArrayUint32[sectionHeaderBaseUint32 + 9];
      const bucketsMetaDataSizeBytes = partiallyFilledBucketCount * 4;
      const bucketsStorageSizeBytes =
        bucketStorageSizeBytes * bucketCount + bucketsMetaDataSizeBytes;

      const sphericalHarmonicsDegree =
        sectionHeaderArrayUint16[sectionHeaderBaseUint16 + 20];
      const { bytesPerSplat } = SplatBuffer.calculateComponentStorage(
        compressionLevel,
        sphericalHarmonicsDegree,
      );

      const splatDataStorageSizeBytes = bytesPerSplat * maxSplatCount;
      const storageSizeBytes =
        splatDataStorageSizeBytes + bucketsStorageSizeBytes;
      const sectionHeader = {
        bytesPerSplat: bytesPerSplat,
        splatCountOffset: splatCountOffset,
        splatCount: secLoadedCountsToMax ? maxSplatCount : 0,
        maxSplatCount: maxSplatCount,
        bucketSize: bucketSize,
        bucketCount: bucketCount,
        bucketBlockSize: bucketBlockSize,
        halfBucketBlockSize: halfBucketBlockSize,
        bucketStorageSizeBytes: bucketStorageSizeBytes,
        bucketsStorageSizeBytes: bucketsStorageSizeBytes,
        splatDataStorageSizeBytes: splatDataStorageSizeBytes,
        storageSizeBytes: storageSizeBytes,
        compressionScaleRange: compressionScaleRange,
        compressionScaleFactor: halfBucketBlockSize / compressionScaleRange,
        base: sectionBase,
        bucketsBase: sectionBase + bucketsMetaDataSizeBytes,
        dataBase: sectionBase + bucketsStorageSizeBytes,
        fullBucketCount: fullBucketCount,
        partiallyFilledBucketCount: partiallyFilledBucketCount,
        sphericalHarmonicsDegree: sphericalHarmonicsDegree,
      };
      sectionHeaders[i] = sectionHeader;
      sectionBase += storageSizeBytes;
      sectionHeaderBase += SplatBuffer.SectionHeaderSizeBytes;
      sectionHeaderBaseUint16 = sectionHeaderBase / 2;
      sectionHeaderBaseUint32 = sectionHeaderBase / 4;
      splatCountOffset += maxSplatCount;
    }

    return sectionHeaders;
  }

  static writeSectionHeaderToBuffer(
    sectionHeader,
    compressionLevel,
    buffer,
    offset = 0,
  ) {
    const sectionHeadeArrayUint16 = new Uint16Array(
      buffer,
      offset,
      SplatBuffer.SectionHeaderSizeBytes / 2,
    );
    const sectionHeadeArrayUint32 = new Uint32Array(
      buffer,
      offset,
      SplatBuffer.SectionHeaderSizeBytes / 4,
    );
    const sectionHeadeArrayFloat32 = new Float32Array(
      buffer,
      offset,
      SplatBuffer.SectionHeaderSizeBytes / 4,
    );

    sectionHeadeArrayUint32[0] = sectionHeader.splatCount;
    sectionHeadeArrayUint32[1] = sectionHeader.maxSplatCount;
    sectionHeadeArrayUint32[2] =
      compressionLevel >= 1 ? sectionHeader.bucketSize : 0;
    sectionHeadeArrayUint32[3] =
      compressionLevel >= 1 ? sectionHeader.bucketCount : 0;
    sectionHeadeArrayFloat32[4] =
      compressionLevel >= 1 ? sectionHeader.bucketBlockSize : 0.0;
    sectionHeadeArrayUint16[10] =
      compressionLevel >= 1 ? SplatBuffer.BucketStorageSizeBytes : 0;
    sectionHeadeArrayUint32[6] =
      compressionLevel >= 1 ? sectionHeader.compressionScaleRange : 0;
    sectionHeadeArrayUint32[7] = sectionHeader.storageSizeBytes;
    sectionHeadeArrayUint32[8] =
      compressionLevel >= 1 ? sectionHeader.fullBucketCount : 0;
    sectionHeadeArrayUint32[9] =
      compressionLevel >= 1 ? sectionHeader.partiallyFilledBucketCount : 0;
    sectionHeadeArrayUint16[20] = sectionHeader.sphericalHarmonicsDegree;
  }

  static writeSectionHeaderSplatCountToBuffer(splatCount, buffer, offset = 0) {
    const sectionHeadeArrayUint32 = new Uint32Array(
      buffer,
      offset,
      SplatBuffer.SectionHeaderSizeBytes / 4,
    );
    sectionHeadeArrayUint32[0] = splatCount;
  }

  constructFromBuffer(bufferData, secLoadedCountsToMax) {
    this.bufferData = bufferData;

    this.globalSplatIndexToLocalSplatIndexMap = [];
    this.globalSplatIndexToSectionMap = [];

    const header = SplatBuffer.parseHeader(this.bufferData);
    this.versionMajor = header.versionMajor;
    this.versionMinor = header.versionMinor;
    this.maxSectionCount = header.maxSectionCount;
    this.sectionCount = secLoadedCountsToMax ? header.maxSectionCount : 0;
    this.maxSplatCount = header.maxSplatCount;
    this.splatCount = secLoadedCountsToMax ? header.maxSplatCount : 0;
    this.compressionLevel = header.compressionLevel;
    this.sceneCenter = new THREE.Vector3().copy(header.sceneCenter);
    this.minSphericalHarmonicsCoeff = header.minSphericalHarmonicsCoeff;
    this.maxSphericalHarmonicsCoeff = header.maxSphericalHarmonicsCoeff;

    this.sections = SplatBuffer.parseSectionHeaders(
      header,
      this.bufferData,
      SplatBuffer.HeaderSizeBytes,
      secLoadedCountsToMax,
    );

    this.linkBufferArrays();
    this.buildMaps();
  }

  static calculateComponentStorage(compressionLevel, sphericalHarmonicsDegree) {
    const bytesPerCenter =
      SplatBuffer.CompressionLevels[compressionLevel].BytesPerCenter;
    const bytesPerScale =
      SplatBuffer.CompressionLevels[compressionLevel].BytesPerScale;
    const bytesPerRotation =
      SplatBuffer.CompressionLevels[compressionLevel].BytesPerRotation;
    const bytesPerColor =
      SplatBuffer.CompressionLevels[compressionLevel].BytesPerColor;
    const sphericalHarmonicsComponentsPerSplat =
      getSphericalHarmonicsComponentCountForDegree(sphericalHarmonicsDegree);
    const sphericalHarmonicsBytesPerSplat =
      SplatBuffer.CompressionLevels[compressionLevel]
        .BytesPerSphericalHarmonicsComponent *
      sphericalHarmonicsComponentsPerSplat;
    const bytesPerSplat =
      bytesPerCenter +
      bytesPerScale +
      bytesPerRotation +
      bytesPerColor +
      sphericalHarmonicsBytesPerSplat;
    return {
      bytesPerCenter,
      bytesPerScale,
      bytesPerRotation,
      bytesPerColor,
      sphericalHarmonicsComponentsPerSplat,
      sphericalHarmonicsBytesPerSplat,
      bytesPerSplat,
    };
  }

  linkBufferArrays() {
    for (let i = 0; i < this.maxSectionCount; i++) {
      const section = this.sections[i];
      section.bucketArray = new Float32Array(
        this.bufferData,
        section.bucketsBase,
        section.bucketCount * SplatBuffer.BucketStorageSizeFloats,
      );
      if (section.partiallyFilledBucketCount > 0) {
        section.partiallyFilledBucketLengths = new Uint32Array(
          this.bufferData,
          section.base,
          section.partiallyFilledBucketCount,
        );
      }
    }
  }

  buildMaps() {
    let cumulativeSplatCount = 0;
    for (let i = 0; i < this.maxSectionCount; i++) {
      const section = this.sections[i];
      for (let j = 0; j < section.maxSplatCount; j++) {
        const globalSplatIndex = cumulativeSplatCount + j;
        this.globalSplatIndexToLocalSplatIndexMap[globalSplatIndex] = j;
        this.globalSplatIndexToSectionMap[globalSplatIndex] = i;
      }
      cumulativeSplatCount += section.maxSplatCount;
    }
  }

  updateLoadedCounts(newSectionCount, newSplatCount) {
    SplatBuffer.writeHeaderCountsToBuffer(
      newSectionCount,
      newSplatCount,
      this.bufferData,
    );
    this.sectionCount = newSectionCount;
    this.splatCount = newSplatCount;
  }

  updateSectionLoadedCounts(sectionIndex, newSplatCount) {
    const sectionHeaderOffset =
      SplatBuffer.HeaderSizeBytes +
      SplatBuffer.SectionHeaderSizeBytes * sectionIndex;
    SplatBuffer.writeSectionHeaderSplatCountToBuffer(
      newSplatCount,
      this.bufferData,
      sectionHeaderOffset,
    );
    this.sections[sectionIndex].splatCount = newSplatCount;
  }

  static writeSplatDataToSectionBuffer = (function() {
    const tempCenterBuffer = new ArrayBuffer(12);
    const tempScaleBuffer = new ArrayBuffer(12);
    const tempRotationBuffer = new ArrayBuffer(16);
    const tempColorBuffer = new ArrayBuffer(4);
    const tempSHBuffer = new ArrayBuffer(256);
    const tempRot = new THREE.Quaternion();
    const tempScale = new THREE.Vector3();
    const bucketCenterDelta = new THREE.Vector3();

    const {
      X: OFFSET_X,
      Y: OFFSET_Y,
      Z: OFFSET_Z,
      SCALE0: OFFSET_SCALE0,
      SCALE1: OFFSET_SCALE1,
      SCALE2: OFFSET_SCALE2,
      ROTATION0: OFFSET_ROT0,
      ROTATION1: OFFSET_ROT1,
      ROTATION2: OFFSET_ROT2,
      ROTATION3: OFFSET_ROT3,
      FDC0: OFFSET_FDC0,
      FDC1: OFFSET_FDC1,
      FDC2: OFFSET_FDC2,
      OPACITY: OFFSET_OPACITY,
      FRC0: OFFSET_FRC0,
      FRC9: OFFSET_FRC9,
      FRC24: OFFSET_FRC24,
    } = UncompressedSplatArray.OFFSET;

    const compressPositionOffset = (
      v,
      compressionScaleFactor,
      compressionScaleRange,
    ) => {
      const doubleCompressionScaleRange = compressionScaleRange * 2 + 1;
      v = Math.round(v * compressionScaleFactor) + compressionScaleRange;
      return clamp(v, 0, doubleCompressionScaleRange);
    };

    return function(
      targetSplat,
      sectionBuffer,
      bufferOffset,
      compressionLevel,
      sphericalHarmonicsDegree,
      bucketCenter,
      compressionScaleFactor,
      compressionScaleRange,
      minSphericalHarmonicsCoeff = -DefaultSphericalHarmonics8BitCompressionHalfRange,
      maxSphericalHarmonicsCoeff = DefaultSphericalHarmonics8BitCompressionHalfRange,
    ) {
      const sphericalHarmonicsComponentsPerSplat =
        getSphericalHarmonicsComponentCountForDegree(sphericalHarmonicsDegree);
      const bytesPerCenter =
        SplatBuffer.CompressionLevels[compressionLevel].BytesPerCenter;
      const bytesPerScale =
        SplatBuffer.CompressionLevels[compressionLevel].BytesPerScale;
      const bytesPerRotation =
        SplatBuffer.CompressionLevels[compressionLevel].BytesPerRotation;
      const bytesPerColor =
        SplatBuffer.CompressionLevels[compressionLevel].BytesPerColor;

      const centerBase = bufferOffset;
      const scaleBase = centerBase + bytesPerCenter;
      const rotationBase = scaleBase + bytesPerScale;
      const colorBase = rotationBase + bytesPerRotation;
      const sphericalHarmonicsBase = colorBase + bytesPerColor;

      if (targetSplat[OFFSET_ROT0] !== undefined) {
        tempRot.set(
          targetSplat[OFFSET_ROT0],
          targetSplat[OFFSET_ROT1],
          targetSplat[OFFSET_ROT2],
          targetSplat[OFFSET_ROT3],
        );
        tempRot.normalize();
      } else {
        tempRot.set(1.0, 0.0, 0.0, 0.0);
      }

      if (targetSplat[OFFSET_SCALE0] !== undefined) {
        tempScale.set(
          targetSplat[OFFSET_SCALE0] || 0,
          targetSplat[OFFSET_SCALE1] || 0,
          targetSplat[OFFSET_SCALE2] || 0,
        );
      } else {
        tempScale.set(0, 0, 0);
      }

      if (compressionLevel === 0) {
        const center = new Float32Array(
          sectionBuffer,
          centerBase,
          SplatBuffer.CenterComponentCount,
        );
        const rot = new Float32Array(
          sectionBuffer,
          rotationBase,
          SplatBuffer.RotationComponentCount,
        );
        const scale = new Float32Array(
          sectionBuffer,
          scaleBase,
          SplatBuffer.ScaleComponentCount,
        );

        rot.set([tempRot.x, tempRot.y, tempRot.z, tempRot.w]);
        scale.set([tempScale.x, tempScale.y, tempScale.z]);
        center.set([
          targetSplat[OFFSET_X],
          targetSplat[OFFSET_Y],
          targetSplat[OFFSET_Z],
        ]);

        if (sphericalHarmonicsDegree > 0) {
          const shOut = new Float32Array(
            sectionBuffer,
            sphericalHarmonicsBase,
            sphericalHarmonicsComponentsPerSplat,
          );
          if (sphericalHarmonicsDegree >= 1) {
            for (let s = 0; s < 9; s++) {
              shOut[s] = targetSplat[OFFSET_FRC0 + s] || 0;
            }
            if (sphericalHarmonicsDegree >= 2) {
              for (let s = 0; s < 15; s++) {
                shOut[s + 9] = targetSplat[OFFSET_FRC9 + s] || 0;
              }
              if (sphericalHarmonicsDegree >= 3) {
                for (let s = 0; s < 21; s++) {
                  shOut[s + 24] = targetSplat[OFFSET_FRC24 + s] || 0;
                }
              }
            }
          }
        }
      } else {
        const center = new Uint16Array(
          tempCenterBuffer,
          0,
          SplatBuffer.CenterComponentCount,
        );
        const rot = new Uint16Array(
          tempRotationBuffer,
          0,
          SplatBuffer.RotationComponentCount,
        );
        const scale = new Uint16Array(
          tempScaleBuffer,
          0,
          SplatBuffer.ScaleComponentCount,
        );

        rot.set([
          toHalfFloat(tempRot.x),
          toHalfFloat(tempRot.y),
          toHalfFloat(tempRot.z),
          toHalfFloat(tempRot.w),
        ]);
        scale.set([
          toHalfFloat(tempScale.x),
          toHalfFloat(tempScale.y),
          toHalfFloat(tempScale.z),
        ]);

        bucketCenterDelta
          .set(
            targetSplat[OFFSET_X],
            targetSplat[OFFSET_Y],
            targetSplat[OFFSET_Z],
          )
          .sub(bucketCenter);
        bucketCenterDelta.x = compressPositionOffset(
          bucketCenterDelta.x,
          compressionScaleFactor,
          compressionScaleRange,
        );
        bucketCenterDelta.y = compressPositionOffset(
          bucketCenterDelta.y,
          compressionScaleFactor,
          compressionScaleRange,
        );
        bucketCenterDelta.z = compressPositionOffset(
          bucketCenterDelta.z,
          compressionScaleFactor,
          compressionScaleRange,
        );
        center.set([
          bucketCenterDelta.x,
          bucketCenterDelta.y,
          bucketCenterDelta.z,
        ]);

        if (sphericalHarmonicsDegree > 0) {
          const SHArrayType = compressionLevel === 1 ? Uint16Array : Uint8Array;
          const bytesPerSHComponent = compressionLevel === 1 ? 2 : 1;
          const shOut = new SHArrayType(
            tempSHBuffer,
            0,
            sphericalHarmonicsComponentsPerSplat,
          );
          if (sphericalHarmonicsDegree >= 1) {
            for (let s = 0; s < 9; s++) {
              const srcVal = targetSplat[OFFSET_FRC0 + s] || 0;
              shOut[s] =
                compressionLevel === 1 ?
                  toHalfFloat(srcVal) :
                  toUint8(
                      srcVal,
                      minSphericalHarmonicsCoeff,
                      maxSphericalHarmonicsCoeff,
                    );
            }
            const degree1ByteCount = 9 * bytesPerSHComponent;
            copyBetweenBuffers(
              shOut.buffer,
              0,
              sectionBuffer,
              sphericalHarmonicsBase,
              degree1ByteCount,
            );
            if (sphericalHarmonicsDegree >= 2) {
              for (let s = 0; s < 15; s++) {
                const srcVal = targetSplat[OFFSET_FRC9 + s] || 0;
                shOut[s + 9] =
                  compressionLevel === 1 ?
                    toHalfFloat(srcVal) :
                    toUint8(
                        srcVal,
                        minSphericalHarmonicsCoeff,
                        maxSphericalHarmonicsCoeff,
                      );
              }
              copyBetweenBuffers(
                shOut.buffer,
                degree1ByteCount,
                sectionBuffer,
                sphericalHarmonicsBase + degree1ByteCount,
                15 * bytesPerSHComponent,
              );
            }
          }
        }

        copyBetweenBuffers(center.buffer, 0, sectionBuffer, centerBase, 6);
        copyBetweenBuffers(scale.buffer, 0, sectionBuffer, scaleBase, 6);
        copyBetweenBuffers(rot.buffer, 0, sectionBuffer, rotationBase, 8);
      }

      const rgba = new Uint8ClampedArray(tempColorBuffer, 0, 4);
      rgba.set([
        targetSplat[OFFSET_FDC0] || 0,
        targetSplat[OFFSET_FDC1] || 0,
        targetSplat[OFFSET_FDC2] || 0,
      ]);
      rgba[3] = targetSplat[OFFSET_OPACITY] || 0;

      copyBetweenBuffers(rgba.buffer, 0, sectionBuffer, colorBase, 4);
    };
  })();

  static generateFromUncompressedSplatArrays(
    splatArrays,
    minimumAlpha,
    compressionLevel,
    sceneCenter,
    blockSize,
    bucketSize,
    options = [],
  ) {
    let shDegree = 0;
    for (let sa = 0; sa < splatArrays.length; sa++) {
      const splatArray = splatArrays[sa];
      shDegree = Math.max(splatArray.sphericalHarmonicsDegree, shDegree);
    }

    let minSphericalHarmonicsCoeff;
    let maxSphericalHarmonicsCoeff;

    for (let sa = 0; sa < splatArrays.length; sa++) {
      const splatArray = splatArrays[sa];
      for (let i = 0; i < splatArray.splats.length; i++) {
        const splat = splatArray.splats[i];
        for (
          let sc = UncompressedSplatArray.OFFSET.FRC0;
          sc < UncompressedSplatArray.OFFSET.FRC44 && sc < splat.length;
          sc++
        ) {
          if (
            !minSphericalHarmonicsCoeff ||
            splat[sc] < minSphericalHarmonicsCoeff
          ) {
            minSphericalHarmonicsCoeff = splat[sc];
          }
          if (
            !maxSphericalHarmonicsCoeff ||
            splat[sc] > maxSphericalHarmonicsCoeff
          ) {
            maxSphericalHarmonicsCoeff = splat[sc];
          }
        }
      }
    }

    minSphericalHarmonicsCoeff =
      minSphericalHarmonicsCoeff ||
      -DefaultSphericalHarmonics8BitCompressionHalfRange;
    maxSphericalHarmonicsCoeff =
      maxSphericalHarmonicsCoeff ||
      DefaultSphericalHarmonics8BitCompressionHalfRange;

    const { bytesPerSplat } = SplatBuffer.calculateComponentStorage(
      compressionLevel,
      shDegree,
    );
    const compressionScaleRange =
      SplatBuffer.CompressionLevels[compressionLevel].ScaleRange;

    const sectionBuffers = [];
    const sectionHeaderBuffers = [];
    let totalSplatCount = 0;

    for (let sa = 0; sa < splatArrays.length; sa++) {
      const splatArray = splatArrays[sa];
      const validSplats = new UncompressedSplatArray(shDegree);
      for (let i = 0; i < splatArray.splatCount; i++) {
        const targetSplat = splatArray.splats[i];
        if (
          (targetSplat[UncompressedSplatArray.OFFSET.OPACITY] || 0) >=
          minimumAlpha
        ) {
          validSplats.addSplat(targetSplat);
        }
      }

      const sectionOptions = options[sa] || {};
      const sectionBlockSize =
        (sectionOptions.blockSizeFactor || 1) *
        (blockSize || SplatBuffer.BucketBlockSize);
      const sectionBucketSize = Math.ceil(
        (sectionOptions.bucketSizeFactor || 1) *
          (bucketSize || SplatBuffer.BucketSize),
      );

      const bucketInfo = SplatBuffer.computeBucketsForUncompressedSplatArray(
        validSplats,
        sectionBlockSize,
        sectionBucketSize,
      );
      const fullBucketCount = bucketInfo.fullBuckets.length;
      const partiallyFullBucketLengths = bucketInfo.partiallyFullBuckets.map(
        (bucket) => bucket.splats.length,
      );
      const partiallyFilledBucketCount = partiallyFullBucketLengths.length;
      const buckets = [
        ...bucketInfo.fullBuckets,
        ...bucketInfo.partiallyFullBuckets,
      ];

      const sectionDataSizeBytes = validSplats.splats.length * bytesPerSplat;
      const bucketMetaDataSizeBytes = partiallyFilledBucketCount * 4;
      const bucketDataBytes =
        compressionLevel >= 1 ?
          buckets.length * SplatBuffer.BucketStorageSizeBytes +
            bucketMetaDataSizeBytes :
          0;
      const sectionSizeBytes = sectionDataSizeBytes + bucketDataBytes;
      const sectionBuffer = new ArrayBuffer(sectionSizeBytes);

      const compressionScaleFactor =
        compressionScaleRange / (sectionBlockSize * 0.5);
      const bucketCenter = new THREE.Vector3();

      let outSplatCount = 0;
      for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b];
        bucketCenter.fromArray(bucket.center);
        for (let i = 0; i < bucket.splats.length; i++) {
          let row = bucket.splats[i];
          const targetSplat = validSplats.splats[row];
          const bufferOffset = bucketDataBytes + outSplatCount * bytesPerSplat;
          SplatBuffer.writeSplatDataToSectionBuffer(
            targetSplat,
            sectionBuffer,
            bufferOffset,
            compressionLevel,
            shDegree,
            bucketCenter,
            compressionScaleFactor,
            compressionScaleRange,
            minSphericalHarmonicsCoeff,
            maxSphericalHarmonicsCoeff,
          );
          outSplatCount++;
        }
      }
      totalSplatCount += outSplatCount;

      if (compressionLevel >= 1) {
        const bucketMetaDataArray = new Uint32Array(
          sectionBuffer,
          0,
          partiallyFullBucketLengths.length * 4,
        );
        for (let pfb = 0; pfb < partiallyFullBucketLengths.length; pfb++) {
          bucketMetaDataArray[pfb] = partiallyFullBucketLengths[pfb];
        }
        const bucketArray = new Float32Array(
          sectionBuffer,
          bucketMetaDataSizeBytes,
          buckets.length * SplatBuffer.BucketStorageSizeFloats,
        );
        for (let b = 0; b < buckets.length; b++) {
          const bucket = buckets[b];
          const base = b * 3;
          bucketArray[base] = bucket.center[0];
          bucketArray[base + 1] = bucket.center[1];
          bucketArray[base + 2] = bucket.center[2];
        }
      }
      sectionBuffers.push(sectionBuffer);

      const sectionHeaderBuffer = new ArrayBuffer(
        SplatBuffer.SectionHeaderSizeBytes,
      );
      SplatBuffer.writeSectionHeaderToBuffer(
        {
          maxSplatCount: outSplatCount,
          splatCount: outSplatCount,
          bucketSize: sectionBucketSize,
          bucketCount: buckets.length,
          bucketBlockSize: sectionBlockSize,
          compressionScaleRange: compressionScaleRange,
          storageSizeBytes: sectionSizeBytes,
          fullBucketCount: fullBucketCount,
          partiallyFilledBucketCount: partiallyFilledBucketCount,
          sphericalHarmonicsDegree: shDegree,
        },
        compressionLevel,
        sectionHeaderBuffer,
        0,
      );
      sectionHeaderBuffers.push(sectionHeaderBuffer);
    }

    let sectionsCumulativeSizeBytes = 0;
    for (let sectionBuffer of sectionBuffers) {
      sectionsCumulativeSizeBytes += sectionBuffer.byteLength;
    }
    const unifiedBufferSize =
      SplatBuffer.HeaderSizeBytes +
      SplatBuffer.SectionHeaderSizeBytes * sectionBuffers.length +
      sectionsCumulativeSizeBytes;
    const unifiedBuffer = new ArrayBuffer(unifiedBufferSize);

    SplatBuffer.writeHeaderToBuffer(
      {
        versionMajor: 0,
        versionMinor: 1,
        maxSectionCount: sectionBuffers.length,
        sectionCount: sectionBuffers.length,
        maxSplatCount: totalSplatCount,
        splatCount: totalSplatCount,
        compressionLevel: compressionLevel,
        sceneCenter: sceneCenter,
        minSphericalHarmonicsCoeff: minSphericalHarmonicsCoeff,
        maxSphericalHarmonicsCoeff: maxSphericalHarmonicsCoeff,
      },
      unifiedBuffer,
    );

    let currentUnifiedBase = SplatBuffer.HeaderSizeBytes;
    for (let sectionHeaderBuffer of sectionHeaderBuffers) {
      new Uint8Array(
        unifiedBuffer,
        currentUnifiedBase,
        SplatBuffer.SectionHeaderSizeBytes,
      ).set(new Uint8Array(sectionHeaderBuffer));
      currentUnifiedBase += SplatBuffer.SectionHeaderSizeBytes;
    }

    for (let sectionBuffer of sectionBuffers) {
      new Uint8Array(
        unifiedBuffer,
        currentUnifiedBase,
        sectionBuffer.byteLength,
      ).set(new Uint8Array(sectionBuffer));
      currentUnifiedBase += sectionBuffer.byteLength;
    }

    const splatBuffer = new SplatBuffer(unifiedBuffer);
    return splatBuffer;
  }

  static computeBucketsForUncompressedSplatArray(
    splatArray,
    blockSize,
    bucketSize,
  ) {
    let splatCount = splatArray.splatCount;
    const halfBlockSize = blockSize / 2.0;

    const min = new THREE.Vector3();
    const max = new THREE.Vector3();

    for (let i = 0; i < splatCount; i++) {
      const targetSplat = splatArray.splats[i];
      const center = [
        targetSplat[UncompressedSplatArray.OFFSET.X],
        targetSplat[UncompressedSplatArray.OFFSET.Y],
        targetSplat[UncompressedSplatArray.OFFSET.Z],
      ];
      if (i === 0 || center[0] < min.x) min.x = center[0];
      if (i === 0 || center[0] > max.x) max.x = center[0];
      if (i === 0 || center[1] < min.y) min.y = center[1];
      if (i === 0 || center[1] > max.y) max.y = center[1];
      if (i === 0 || center[2] < min.z) min.z = center[2];
      if (i === 0 || center[2] > max.z) max.z = center[2];
    }

    const dimensions = new THREE.Vector3().copy(max).sub(min);
    const yBlocks = Math.ceil(dimensions.y / blockSize);
    const zBlocks = Math.ceil(dimensions.z / blockSize);

    const blockCenter = new THREE.Vector3();
    const fullBuckets = [];
    const partiallyFullBuckets = {};

    for (let i = 0; i < splatCount; i++) {
      const targetSplat = splatArray.splats[i];
      const center = [
        targetSplat[UncompressedSplatArray.OFFSET.X],
        targetSplat[UncompressedSplatArray.OFFSET.Y],
        targetSplat[UncompressedSplatArray.OFFSET.Z],
      ];
      const xBlock = Math.floor((center[0] - min.x) / blockSize);
      const yBlock = Math.floor((center[1] - min.y) / blockSize);
      const zBlock = Math.floor((center[2] - min.z) / blockSize);

      blockCenter.x = xBlock * blockSize + min.x + halfBlockSize;
      blockCenter.y = yBlock * blockSize + min.y + halfBlockSize;
      blockCenter.z = zBlock * blockSize + min.z + halfBlockSize;

      const bucketId = xBlock * (yBlocks * zBlocks) + yBlock * zBlocks + zBlock;
      let bucket = partiallyFullBuckets[bucketId];
      if (!bucket) {
        partiallyFullBuckets[bucketId] = bucket = {
          splats: [],
          center: blockCenter.toArray(),
        };
      }

      bucket.splats.push(i);
      if (bucket.splats.length >= bucketSize) {
        fullBuckets.push(bucket);
        partiallyFullBuckets[bucketId] = null;
      }
    }

    const partiallyFullBucketArray = [];
    for (let bucketId in partiallyFullBuckets) {
      if (partiallyFullBuckets.hasOwnProperty(bucketId)) {
        const bucket = partiallyFullBuckets[bucketId];
        if (bucket) {
          partiallyFullBucketArray.push(bucket);
        }
      }
    }

    return {
      fullBuckets: fullBuckets,
      partiallyFullBuckets: partiallyFullBucketArray,
    };
  }
}
