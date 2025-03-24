import * as THREE from 'three';
import { Constants } from '../Constants.js';

export class SplatMaterial {
  static buildVertexShaderBase(
    dynamicMode = false,
    enableOptionalEffects = false,
    maxSphericalHarmonicsDegree = 0,
    customVars = '',
  ) {
    let vertexShaderSource = `
        precision highp float;
        #include <common>

        attribute uint splatIndex;
        uniform highp usampler2D centersColorsTexture;
        uniform highp sampler2D sphericalHarmonicsTexture;
        uniform highp usampler2D sphericalHarmonicsTextureR;
        uniform highp usampler2D sphericalHarmonicsTextureG;
        uniform highp usampler2D sphericalHarmonicsTextureB;

        uniform highp usampler2D sceneIndexesTexture;
        uniform vec2 sceneIndexesTextureSize;
        uniform int sceneCount;
    `;

    if (enableOptionalEffects) {
      vertexShaderSource += `
            uniform float sceneOpacity[${Constants.MaxScenes}];
            uniform int sceneVisibility[${Constants.MaxScenes}];
        `;
    }

    if (dynamicMode) {
      vertexShaderSource += `
            uniform highp mat4 transforms[${Constants.MaxScenes}];
        `;
    }

    vertexShaderSource += `
        ${customVars}
        uniform vec2 focal;
        uniform float orthoZoom;
        uniform int orthographicMode;
        uniform int pointCloudModeEnabled;
        uniform float inverseFocalAdjustment;
        uniform vec2 viewport;
        uniform vec2 basisViewport;
        uniform vec2 centersColorsTextureSize;
        uniform int sphericalHarmonicsDegree;
        uniform vec2 sphericalHarmonicsTextureSize;
        uniform int sphericalHarmonics8BitMode;
        uniform int sphericalHarmonicsMultiTextureMode;
        uniform float visibleRegionRadius;
        uniform float visibleRegionFadeStartRadius;
        uniform float firstRenderTime;
        uniform float currentTime;
        uniform int fadeInComplete;
        uniform vec3 sceneCenter;
        uniform float splatScale;
        uniform float sphericalHarmonics8BitCompressionRangeMin[${Constants.MaxScenes}];
        uniform float sphericalHarmonics8BitCompressionRangeMax[${Constants.MaxScenes}];        
        uniform float harmonicsRangeMin;
        uniform float harmonicsRange;

        varying vec4 vColor;
        varying vec2 vUv;
        varying vec2 vPosition;
        varying float vZ;
        varying float vSplatIndex;
        varying vec4 vVertex;

        mat3 quaternionToRotationMatrix(float x, float y, float z, float w) {
            float s = 1.0 / sqrt(w * w + x * x + y * y + z * z);
        
            return mat3(
                1. - 2. * (y * y + z * z),
                2. * (x * y + w * z),
                2. * (x * z - w * y),
                2. * (x * y - w * z),
                1. - 2. * (x * x + z * z),
                2. * (y * z + w * x),
                2. * (x * z + w * y),
                2. * (y * z - w * x),
                1. - 2. * (x * x + y * y)
            );
        }

        const float sqrt8 = sqrt(8.0);
        const float minAlpha = 1.0 / 255.0;

        const vec4 encodeNorm4 = vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0);
        const uvec4 mask4 = uvec4(uint(0x000000FF), uint(0x0000FF00), uint(0x00FF0000), uint(0xFF000000));
        const uvec4 shift4 = uvec4(0, 8, 16, 24);
        vec4 uintToRGBAVec (uint u) {
           uvec4 urgba = mask4 & u;
           urgba = urgba >> shift4;
           vec4 rgba = vec4(urgba) * encodeNorm4;
           return rgba;
        }
        vec3 unpack111011s(uint bits) { 
          vec3 result = vec3((uvec3(bits) >> uvec3(21u, 11u, 0u)) & uvec3(0x7ffu, 0x3ffu, 0x7ffu)) / vec3(2047.0, 1023.0, 2047.0); 
          return result * 2. - 1.;
        }
        vec2 getDataUV(in int stride, in int offset, in vec2 dimensions) {
            vec2 samplerUV = vec2(0.0, 0.0);
            float d = float(splatIndex * uint(stride) + uint(offset)) / dimensions.x;
            samplerUV.y = float(floor(d)) / dimensions.y;
            samplerUV.x = fract(d);
            return samplerUV;
        }        
        ivec2 getDataUVSplat(in int stride, in int offset, in vec2 dimensions) {
            ivec2 samplerUV = ivec2(0, 0);
            float d = float(splatIndex * uint(stride) + uint(offset));
            samplerUV.y = int(floor(d / dimensions.x));
            samplerUV.x = int(mod(d, dimensions.x));
            return samplerUV;
        }
        vec2 getDataUVF(in uint sIndex, in float stride, in uint offset, in vec2 dimensions) {
            vec2 samplerUV = vec2(0.0, 0.0);
            float d = float(uint(float(sIndex) * stride) + offset) / dimensions.x;
            samplerUV.y = float(floor(d)) / dimensions.y;
            samplerUV.x = fract(d);
            return samplerUV;
        }

        const float SH_C1 = 0.4886025119029199f;
        const float[5] SH_C2 = float[](1.0925484, -1.0925484, 0.3153916, -1.0925484, 0.5462742);
        const float[7] SH_C3 = float[](-0.5900435899266435, 
                                        2.890611442640554, 
                                        -0.4570457994644658, 
                                        0.3731763325901154, 
                                        -0.4570457994644658, 
                                        1.445305721320277, 
                                        -0.5900435899266435);
        void main () {

            vSplatIndex = float(splatIndex);

            uint oddOffset = splatIndex & uint(0x00000001);
            uint doubleOddOffset = oddOffset * uint(2);
            bool isEven = oddOffset == uint(0);
            uint nearestEvenIndex = splatIndex - oddOffset;
            float fOddOffset = float(oddOffset);

            uvec4 sampledCenterColor = texture(centersColorsTexture, getDataUV(1, 0, centersColorsTextureSize));
            vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));

            uint sceneIndex = uint(0);
            if (sceneCount > 1) {
                sceneIndex = texture(sceneIndexesTexture, getDataUV(1, 0, sceneIndexesTextureSize)).r;
            }
            `;

    if (enableOptionalEffects) {
      vertexShaderSource += `
                float splatOpacityFromScene = sceneOpacity[sceneIndex];
                int sceneVisible = sceneVisibility[sceneIndex];
                if (splatOpacityFromScene <= 0.01 || sceneVisible == 0) {
                    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                    return;
                }
            `;
    }

    if (dynamicMode) {
      vertexShaderSource += `
                mat4 transform = transforms[sceneIndex];
                mat4 transformModelViewMatrix = modelViewMatrix * transform;
            `;
    } else {
      vertexShaderSource += `mat4 transformModelViewMatrix = modelViewMatrix;`;
    }

    vertexShaderSource += `


            vec4 viewCenter = transformModelViewMatrix * vec4(splatCenter, 1.0);

            vec4 clipCenter = projectionMatrix * viewCenter;

            float clip = 1.2 * clipCenter.w;
            if (clipCenter.z < -clip || clipCenter.x < -clip || clipCenter.x > clip || clipCenter.y < -clip || clipCenter.y > clip) {
                gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                return;
            }

            vec3 ndcCenter = clipCenter.xyz / clipCenter.w;

            vPosition = position.xy;
            vColor = uintToRGBAVec(sampledCenterColor.r);
        `;

    // // Proceed to sampling and rendering 1st degree spherical harmonics
    if (maxSphericalHarmonicsDegree >= 1) {
      vertexShaderSource += `   
            if (sphericalHarmonicsDegree >= 1) {
            `;

      if (dynamicMode) {
        vertexShaderSource += `
                    vec3 worldViewDir = normalize(splatCenter - vec3(inverse(transform) * vec4(cameraPosition, 1.0)));
                `;
      } else {
        vertexShaderSource += `
                    vec3 worldViewDir = normalize(splatCenter - cameraPosition);
                `;
      }

      vertexShaderSource += `
                vec3 harmonics = vec3(0.);
                vec3 sh1 = vec3(0.);
                vec3 sh2 = vec3(0.);
                vec3 sh3 = vec3(0.);
            `;

      if (maxSphericalHarmonicsDegree >= 2) {
        vertexShaderSource += `
                    vec3 sh4 = vec3(0.);
                    vec3 sh5 = vec3(0.);
                    vec3 sh6 = vec3(0.);
                    vec3 sh7 = vec3(0.);
                    vec3 sh8 = vec3(0.);
                `;
      }

      // Adding the third harmonics variables
      if (maxSphericalHarmonicsDegree >= 3) {
        vertexShaderSource += `
                      vec3 sh9 = vec3(0.);
                      vec3 sh10 = vec3(0.);
                      vec3 sh11 = vec3(0.);
                      vec3 sh12 = vec3(0.);
                      vec3 sh13 = vec3(0.);
                      vec3 sh14 = vec3(0.);
                      vec3 sh15 = vec3(0.);
                  `;
      }

      // Sample spherical harmonics textures with 1 degree worth of data for 1st degree calculations, and store in sh1, sh2, and sh3,
      // Calculate the harmonics result for the corresponding values.
      if (maxSphericalHarmonicsDegree >= 1) {
        vertexShaderSource += `
                    
                    vec2 degree1TextureSize = vec2(textureSize(sphericalHarmonicsTextureR, 0));

                    uint d1 = texelFetch(sphericalHarmonicsTextureR, getDataUVSplat(3, 0, degree1TextureSize), 0).r;
                    uint d2 = texelFetch(sphericalHarmonicsTextureR, getDataUVSplat(3, 1, degree1TextureSize), 0).r;
                    uint d3 = texelFetch(sphericalHarmonicsTextureR, getDataUVSplat(3, 2, degree1TextureSize), 0).r;

                    sh1 = unpack111011s(d1);
                    sh2 = unpack111011s(d2);
                    sh3 = unpack111011s(d3);

                    float x = worldViewDir.x;
                    float y = worldViewDir.y;
                    float z = worldViewDir.z;

                    float xx = 1.;
                    float yy = 1.;
                    float zz = 1.;
                    float xy = 1.;
                    float yz = 1.;
                    float xz = 1.;

                    harmonics = SH_C1 * (-sh1 * y + sh2 * z - sh3 * x);
                    
                `;
      }

      // Proceed to sampling and rendering 2nd degree spherical harmonics
      // Sample spherical harmonics textures with 2 degrees worth of data for 2nd degree calculations,
      // and store in sh4, sh5, sh6, sh7, and sh8
      if (maxSphericalHarmonicsDegree >= 2) {
        vertexShaderSource += `

                    if(sphericalHarmonicsDegree >= 2) {
                      vec2 degree2TextureSize = vec2(textureSize(sphericalHarmonicsTextureG, 0));

                      uint d4 = texelFetch(sphericalHarmonicsTextureG, getDataUVSplat(5, 0, degree2TextureSize), 0).r;
                      uint d5 = texelFetch(sphericalHarmonicsTextureG, getDataUVSplat(5, 1, degree2TextureSize), 0).r;
                      uint d6 = texelFetch(sphericalHarmonicsTextureG, getDataUVSplat(5, 2, degree2TextureSize), 0).r;
                      uint d7 = texelFetch(sphericalHarmonicsTextureG, getDataUVSplat(5, 3, degree2TextureSize), 0).r;
                      uint d8 = texelFetch(sphericalHarmonicsTextureG, getDataUVSplat(5, 4, degree2TextureSize), 0).r;


                      sh4 = unpack111011s(d4);
                      sh5 = unpack111011s(d5);
                      sh6 = unpack111011s(d6);
                      sh7 = unpack111011s(d7);
                      sh8 = unpack111011s(d8);


                      xx = x * x;
                      yy = y * y;
                      zz = z * z;
                      xy = x * y;
                      yz = y * z;
                      xz = x * z;

                      harmonics += 
                          (SH_C2[0] * xy) * sh4 +
                          (SH_C2[1] * yz) * sh5 +
                          (SH_C2[2] * (2.0 * zz - xx - yy)) * sh6 +
                          (SH_C2[3] * xz) * sh7 +
                          (SH_C2[4] * (xx - yy)) * sh8;
                    }
                `;

        // Perform 3rd degree spherical harmonics calculations
        if (maxSphericalHarmonicsDegree >= 3) {
          vertexShaderSource += `
      
                    if(sphericalHarmonicsDegree >= 3) {
                      vec2 degree3TextureSize = vec2(textureSize(sphericalHarmonicsTextureB, 0));

                      uint d9 =  texelFetch(sphericalHarmonicsTextureB, getDataUVSplat(7, 0, degree3TextureSize), 0).r;
                      uint d10 = texelFetch(sphericalHarmonicsTextureB, getDataUVSplat(7, 1, degree3TextureSize), 0).r;
                      uint d11 = texelFetch(sphericalHarmonicsTextureB, getDataUVSplat(7, 2, degree3TextureSize), 0).r;
                      uint d12 = texelFetch(sphericalHarmonicsTextureB, getDataUVSplat(7, 3, degree3TextureSize), 0).r;
                      uint d13 = texelFetch(sphericalHarmonicsTextureB, getDataUVSplat(7, 4, degree3TextureSize), 0).r;
                      uint d14 = texelFetch(sphericalHarmonicsTextureB, getDataUVSplat(7, 5, degree3TextureSize), 0).r;
                      uint d15 = texelFetch(sphericalHarmonicsTextureB, getDataUVSplat(7, 6, degree3TextureSize), 0).r;

                      sh9 =  unpack111011s(d9);
                      sh10 = unpack111011s(d10);
                      sh11 = unpack111011s(d11);
                      sh12 = unpack111011s(d12);
                      sh13 = unpack111011s(d13);
                      sh14 = unpack111011s(d14);

                      harmonics +=
                          SH_C3[0] * y * (3.0 * xx - yy) * sh9 +
                          SH_C3[1] * xy * z * sh10 +
                          SH_C3[2] * y * (4.0 * zz - xx - yy) * sh11 +
                          SH_C3[3] * z * (2.0 * zz - 3.0 * xx - 3.0 * yy) * sh12 +
                          SH_C3[4] * x * (4.0 * zz - xx - yy) * sh13 +
                          SH_C3[5] * z * (xx - yy) * sh14 +
                          SH_C3[6] * x * (xx - 3.0 * yy) * sh15;
                    }
                    
                  `;
        }
      }

      vertexShaderSource += `

          vColor.rgb += harmonicsRange * harmonics;
          vColor.rgb = clamp(vColor.rgb, vec3(0.), vec3(1.));

      }

      `;

      return vertexShaderSource;
    }
  }

  static getVertexShaderFadeIn() {
    return `
            if (fadeInComplete == 0) {
                float opacityAdjust = 1.0;
                float centerDist = length(splatCenter - sceneCenter);
                float renderTime = max(currentTime - firstRenderTime, 0.0);

                float fadeDistance = 0.75;
                float distanceLoadFadeInFactor = step(visibleRegionFadeStartRadius, centerDist);
                distanceLoadFadeInFactor = (1.0 - distanceLoadFadeInFactor) +
                                        (1.0 - clamp((centerDist - visibleRegionFadeStartRadius) / fadeDistance, 0.0, 1.0)) *
                                        distanceLoadFadeInFactor;
                opacityAdjust *= distanceLoadFadeInFactor;
                vColor.a *= opacityAdjust;
            }
        `;
  }

  static getUniforms(
    dynamicMode = false,
    enableOptionalEffects = false,
    maxSphericalHarmonicsDegree = 0,
    splatScale = 1.0,
    pointCloudModeEnabled = false,
  ) {
    const uniforms = {
      sceneCenter: {
        type: 'v3',
        value: new THREE.Vector3(),
      },
      fadeInComplete: {
        type: 'i',
        value: 0,
      },
      orthographicMode: {
        type: 'i',
        value: 0,
      },
      visibleRegionFadeStartRadius: {
        type: 'f',
        value: 0.0,
      },
      visibleRegionRadius: {
        type: 'f',
        value: 0.0,
      },
      currentTime: {
        type: 'f',
        value: 0.0,
      },
      firstRenderTime: {
        type: 'f',
        value: 0.0,
      },
      centersColorsTexture: {
        type: 't',
        value: null,
      },
      sphericalHarmonicsTexture: {
        type: 't',
        value: null,
      },
      sphericalHarmonicsTextureR: {
        type: 't',
        value: null,
      },
      sphericalHarmonicsTextureG: {
        type: 't',
        value: null,
      },
      sphericalHarmonicsTextureB: {
        type: 't',
        value: null,
      },
      sphericalHarmonics8BitCompressionRangeMin: {
        type: 'f',
        value: [],
      },
      sphericalHarmonics8BitCompressionRangeMax: {
        type: 'f',
        value: [],
      },
      harmonicsRangeMin: {
        type: 'f',
        value: 0,
      },
      harmonicsRange: {
        type: 'f',
        value: 0,
      },
      focal: {
        type: 'v2',
        value: new THREE.Vector2(),
      },
      orthoZoom: {
        type: 'f',
        value: 1.0,
      },
      inverseFocalAdjustment: {
        type: 'f',
        value: 1.0,
      },
      viewport: {
        type: 'v2',
        value: new THREE.Vector2(),
      },
      basisViewport: {
        type: 'v2',
        value: new THREE.Vector2(),
      },
      debugColor: {
        type: 'v3',
        value: new THREE.Color(),
      },
      centersColorsTextureSize: {
        type: 'v2',
        value: new THREE.Vector2(1024, 1024),
      },
      sphericalHarmonicsDegree: {
        type: 'i',
        value: maxSphericalHarmonicsDegree,
      },
      sphericalHarmonicsTextureSize: {
        type: 'v2',
        value: new THREE.Vector2(1024, 1024),
      },
      sphericalHarmonics8BitMode: {
        type: 'i',
        value: 0,
      },
      sphericalHarmonicsMultiTextureMode: {
        type: 'i',
        value: 0,
      },
      splatScale: {
        type: 'f',
        value: splatScale,
      },
      pointCloudModeEnabled: {
        type: 'i',
        value: pointCloudModeEnabled ? 1 : 0,
      },
      sceneIndexesTexture: {
        type: 't',
        value: null,
      },
      sceneIndexesTextureSize: {
        type: 'v2',
        value: new THREE.Vector2(1024, 1024),
      },
      sceneCount: {
        type: 'i',
        value: 1,
      },
    };
    for (let i = 0; i < Constants.MaxScenes; i++) {
      uniforms.sphericalHarmonics8BitCompressionRangeMin.value.push(
        -Constants.SphericalHarmonics8BitCompressionRange / 2.0,
      );
      uniforms.sphericalHarmonics8BitCompressionRangeMax.value.push(
        Constants.SphericalHarmonics8BitCompressionRange / 2.0,
      );
    }

    if (enableOptionalEffects) {
      const sceneOpacity = [];
      for (let i = 0; i < Constants.MaxScenes; i++) {
        sceneOpacity.push(1.0);
      }
      uniforms['sceneOpacity'] = {
        type: 'f',
        value: sceneOpacity,
      };

      const sceneVisibility = [];
      for (let i = 0; i < Constants.MaxScenes; i++) {
        sceneVisibility.push(1);
      }
      uniforms['sceneVisibility'] = {
        type: 'i',
        value: sceneVisibility,
      };
    }

    if (dynamicMode) {
      const transformMatrices = [];
      for (let i = 0; i < Constants.MaxScenes; i++) {
        transformMatrices.push(new THREE.Matrix4());
      }
      uniforms['transforms'] = {
        type: 'mat4',
        value: transformMatrices,
      };
    }

    return uniforms;
  }
}
