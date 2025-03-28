import * as THREE from 'three';
import { Constants } from '../../Constants.js';
import {
  fetchWithProgress as defaultFetchWithProgress,
  delayedExecute,
  nativePromiseWithExtractedComponents,
} from '../../Util.js';
import { DirectLoadError } from '../DirectLoadError.js';
import { InternalLoadType } from '../InternalLoadType.js';
import { LoaderStatus } from '../LoaderStatus.js';
import { SplatBuffer } from '../SplatBuffer.js';
import { SplatBufferGenerator } from '../SplatBufferGenerator.js';
import { UncompressedSplatArray } from '../UncompressedSplatArray.js';
import { SplatParser } from './SplatParser.js';

function finalize(
  splatData,
  optimizeSplatData,
  minimumAlpha,
  compressionLevel,
  sectionSize,
  sceneCenter,
  blockSize,
  bucketSize,
) {
  if (optimizeSplatData) {
    const splatBufferGenerator = SplatBufferGenerator.getStandardGenerator(
      minimumAlpha,
      compressionLevel,
      sectionSize,
      sceneCenter,
      blockSize,
      bucketSize,
    );
    return splatBufferGenerator.generateFromUncompressedSplatArray(splatData);
  } else {
    return SplatBuffer.generateFromUncompressedSplatArrays(
      [splatData],
      minimumAlpha,
      0,
      new THREE.Vector3(),
    );
  }
}

export class SplatLoader {
  static loadFromURL(
    fileName,
    onProgress,
    loadDirectoToSplatBuffer,
    onProgressiveLoadSectionProgress,
    minimumAlpha,
    compressionLevel,
    optimizeSplatData = true,
    sectionSize,
    sceneCenter,
    blockSize,
    bucketSize,
    fetchWithProgress = defaultFetchWithProgress,
  ) {
    let internalLoadType = loadDirectoToSplatBuffer ?
      InternalLoadType.DirectToSplatBuffer :
      InternalLoadType.DirectToSplatArray;
    if (optimizeSplatData) {
      internalLoadType = InternalLoadType.DirectToSplatArray;
    }

    const splatDataOffsetBytes =
      SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes;
    const directLoadSectionSizeBytes = Constants.ProgressiveLoadSectionSize;
    const sectionCount = 1;

    let directLoadBufferIn;
    let directLoadBufferOut;
    let directLoadSplatBuffer;
    let maxSplatCount = 0;
    let splatCount = 0;

    let standardLoadUncompressedSplatArray;

    const loadPromise = nativePromiseWithExtractedComponents();

    let numBytesStreamed = 0;
    let numBytesLoaded = 0;
    let chunks = [];

    const localOnProgress = (percent, percentStr, chunk, fileSize) => {
      const loadComplete = percent >= 100;

      if (chunk) {
        chunks.push(chunk);
      }

      if (internalLoadType === InternalLoadType.DownloadBeforeProcessing) {
        if (loadComplete) {
          loadPromise.resolve(chunks);
        }
        return;
      }

      if (!fileSize) {
        if (loadDirectoToSplatBuffer) {
          throw new DirectLoadError(
            'Cannon directly load .splat because no file size info is available.',
          );
        } else {
          internalLoadType = InternalLoadType.DownloadBeforeProcessing;
          return;
        }
      }

      if (!directLoadBufferIn) {
        maxSplatCount = fileSize / SplatParser.RowSizeBytes;
        directLoadBufferIn = new ArrayBuffer(fileSize);
        const bytesPerSplat =
          SplatBuffer.CompressionLevels[0].SphericalHarmonicsDegrees[0]
            .BytesPerSplat;
        const splatBufferSizeBytes =
          splatDataOffsetBytes + bytesPerSplat * maxSplatCount;

        if (internalLoadType === InternalLoadType.DirectToSplatBuffer) {
          directLoadBufferOut = new ArrayBuffer(splatBufferSizeBytes);
          SplatBuffer.writeHeaderToBuffer(
            {
              versionMajor: SplatBuffer.CurrentMajorVersion,
              versionMinor: SplatBuffer.CurrentMinorVersion,
              maxSectionCount: sectionCount,
              sectionCount: sectionCount,
              maxSplatCount: maxSplatCount,
              splatCount: splatCount,
              compressionLevel: 0,
              sceneCenter: new THREE.Vector3(),
            },
            directLoadBufferOut,
          );
        } else {
          standardLoadUncompressedSplatArray = new UncompressedSplatArray(0);
        }
      }

      if (chunk) {
        new Uint8Array(
          directLoadBufferIn,
          numBytesLoaded,
          chunk.byteLength,
        ).set(new Uint8Array(chunk));
        numBytesLoaded += chunk.byteLength;

        const bytesLoadedSinceLastSection = numBytesLoaded - numBytesStreamed;
        if (
          bytesLoadedSinceLastSection > directLoadSectionSizeBytes ||
          loadComplete
        ) {
          const bytesToUpdate = loadComplete ?
            bytesLoadedSinceLastSection :
            directLoadSectionSizeBytes;
          const addedSplatCount = bytesToUpdate / SplatParser.RowSizeBytes;
          const newSplatCount = splatCount + addedSplatCount;

          if (internalLoadType === InternalLoadType.DirectToSplatBuffer) {
            SplatParser.parseToUncompressedSplatBufferSection(
              splatCount,
              newSplatCount - 1,
              directLoadBufferIn,
              0,
              directLoadBufferOut,
              splatDataOffsetBytes,
            );
          } else {
            SplatParser.parseToUncompressedSplatArraySection(
              splatCount,
              newSplatCount - 1,
              directLoadBufferIn,
              0,
              standardLoadUncompressedSplatArray,
            );
          }

          splatCount = newSplatCount;

          if (internalLoadType === InternalLoadType.DirectToSplatBuffer) {
            if (!directLoadSplatBuffer) {
              SplatBuffer.writeSectionHeaderToBuffer(
                {
                  maxSplatCount: maxSplatCount,
                  splatCount: splatCount,
                  bucketSize: 0,
                  bucketCount: 0,
                  bucketBlockSize: 0,
                  compressionScaleRange: 0,
                  storageSizeBytes: 0,
                  fullBucketCount: 0,
                  partiallyFilledBucketCount: 0,
                },
                0,
                directLoadBufferOut,
                SplatBuffer.HeaderSizeBytes,
              );
              directLoadSplatBuffer = new SplatBuffer(
                directLoadBufferOut,
                false,
              );
            }
            directLoadSplatBuffer.updateLoadedCounts(1, splatCount);
            if (onProgressiveLoadSectionProgress) {
              onProgressiveLoadSectionProgress(
                directLoadSplatBuffer,
                loadComplete,
              );
            }
          }

          numBytesStreamed += directLoadSectionSizeBytes;
        }
      }

      if (loadComplete) {
        if (internalLoadType === InternalLoadType.DirectToSplatBuffer) {
          loadPromise.resolve(directLoadSplatBuffer);
        } else {
          loadPromise.resolve(standardLoadUncompressedSplatArray);
        }
      }

      if (onProgress) onProgress(percent, percentStr, LoaderStatus.Downloading);
    };

    if (onProgress) onProgress(0, '0%', LoaderStatus.Downloading);
    return fetchWithProgress(fileName, localOnProgress, false).then(() => {
      if (onProgress) onProgress(0, '0%', LoaderStatus.Processing);
      return loadPromise.promise.then((splatData) => {
        if (onProgress) onProgress(100, '100%', LoaderStatus.Done);
        if (internalLoadType === InternalLoadType.DownloadBeforeProcessing) {
          return new Blob(chunks).arrayBuffer().then((splatData) => {
            return SplatLoader.loadFromFileData(
              splatData,
              minimumAlpha,
              compressionLevel,
              optimizeSplatData,
              sectionSize,
              sceneCenter,
              blockSize,
              bucketSize,
            );
          });
        } else if (internalLoadType === InternalLoadType.DirectToSplatBuffer) {
          return splatData;
        } else {
          return delayedExecute(() => {
            return finalize(
              splatData,
              optimizeSplatData,
              minimumAlpha,
              compressionLevel,
              sectionSize,
              sceneCenter,
              blockSize,
              bucketSize,
            );
          });
        }
      });
    });
  }

  static loadFromFileData(
    splatFileData,
    minimumAlpha,
    compressionLevel,
    optimizeSplatData,
    sectionSize,
    sceneCenter,
    blockSize,
    bucketSize,
  ) {
    return delayedExecute(() => {
      const splatArray =
        SplatParser.parseStandardSplatToUncompressedSplatArray(splatFileData);
      return finalize(
        splatArray,
        optimizeSplatData,
        minimumAlpha,
        compressionLevel,
        sectionSize,
        sceneCenter,
        blockSize,
        bucketSize,
      );
    });
  }
}
