/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { useTheme } from '../../Theme.tsx';

// --- Shaders ---

const commonVertexShader = `
  varying vec2 v_uv;
  void main() {
    v_uv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const dropShaderFs = `
  const float PI = 3.141592653589793;
  uniform sampler2D u_texture;
  uniform vec2 u_center;
  uniform float u_radius;
  uniform float u_strength;
  varying vec2 v_uv;

  void main() {
    vec4 info = texture2D(u_texture, v_uv);
    float drop = max(0.0, 1.0 - length(u_center - v_uv) / u_radius);
    drop = 0.5 - cos(drop * PI) * 0.5;
    info.r += drop * u_strength;
    gl_FragColor = info;
  }
`;

const updateShaderFs = `
  uniform sampler2D u_texture;
  uniform vec2 u_delta;
  varying vec2 v_uv;

  void main() {
    vec4 info = texture2D(u_texture, v_uv);
    vec2 dx = vec2(u_delta.x, 0.0);
    vec2 dy = vec2(0.0, u_delta.y);
    float average = (
      texture2D(u_texture, v_uv - dx).r +
      texture2D(u_texture, v_uv + dx).r +
      texture2D(u_texture, v_uv - dy).r +
      texture2D(u_texture, v_uv + dy).r
    ) * 0.25;
    info.g += (average - info.r) * 2.0;
    info.g *= 0.995;
    info.r += info.g;
    gl_FragColor = info;
  }
`;

const normalShaderFs = `
  uniform sampler2D u_texture;
  uniform vec2 u_delta;
  varying vec2 v_uv;

  void main() {
    vec4 info = texture2D(u_texture, v_uv);
    vec3 dx = vec3(u_delta.x, texture2D(u_texture, v_uv + vec2(u_delta.x, 0.0)).r - info.r, 0.0);
    vec3 dy = vec3(0.0, texture2D(u_texture, v_uv + vec2(0.0, u_delta.y)).r - info.r, u_delta.y);
    info.ba = normalize(cross(dy, dx)).xz;
    gl_FragColor = info;
  }
`;

const sphereShaderFs = `
  uniform sampler2D u_texture;
  uniform vec3 u_oldCenter;
  uniform vec3 u_newCenter;
  uniform float u_radius;
  varying vec2 v_uv;

  float volumeInSphere(vec3 center) {
    vec3 worldPos = vec3(v_uv.x * 2.0 - 1.0, 0.0, v_uv.y * 2.0 - 1.0);
    vec2 to_center_2d = worldPos.xz - center.xz;
    float t = length(to_center_2d) / u_radius;
    float dy = exp(-pow(t * 1.5, 6.0));
    float ymin = min(0.0, center.y - dy);
    float ymax = min(max(0.0, center.y + dy), ymin + 2.0 * dy);
    return (ymax - ymin) * 0.1;
  }

  void main() {
    vec4 info = texture2D(u_texture, v_uv);
    info.r += volumeInSphere(u_oldCenter);
    info.r -= volumeInSphere(u_newCenter);
    gl_FragColor = info;
  }
`;

const waterVertexShader = `
  uniform sampler2D u_waterTexture;
  uniform mat4 u_textureMatrix;
  varying vec2 v_uv;
  varying vec3 v_worldPos;
  varying vec4 v_reflectionUv;

  void main() {
    v_uv = uv;
    vec4 info = texture2D(u_waterTexture, uv);
    vec3 pos = position;
    // The plane is in XY, but rotated to be in XZ. The plane's local Z is along the world Y axis.
    pos.z += info.r;
    v_worldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
    v_reflectionUv = u_textureMatrix * vec4(v_worldPos, 1.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(v_worldPos, 1.0);
  }
`;

const waterFragmentShader = `
  #include <packing>
  uniform sampler2D u_waterTexture;
  uniform sampler2D u_reflectionTexture;
  uniform sampler2D u_tiles;
  uniform samplerCube u_skybox;
  uniform vec3 u_lightDir;
  uniform vec3 u_cameraPos;
  uniform vec3 u_sphereCenter;
  uniform float u_sphereRadius;

  varying vec2 v_uv;
  varying vec3 v_worldPos;
  varying vec4 v_reflectionUv;

  const float IOR_AIR = 1.0;
  const float IOR_WATER = 1.333;
  const vec3 abovewaterColor = vec3(0.25, 1.0, 1.25);
  const float poolSize = 2.0;
  const float poolHeight = 1.0;

  vec2 intersectCube(vec3 origin, vec3 ray, vec3 cubeMin, vec3 cubeMax) {
    vec3 tMin = (cubeMin - origin) / ray;
    vec3 tMax = (cubeMax - origin) / ray;
    vec3 t1 = min(tMin, tMax);
    vec3 t2 = max(tMin, tMax);
    float tNear = max(max(t1.x, t1.y), t1.z);
    float tFar = min(min(t2.x, t2.y), t2.z);
    return vec2(tNear, tFar);
  }

  float intersectSphere(vec3 origin, vec3 ray, vec3 sphereCenter, float sphereRadius) {
    vec3 toSphere = origin - sphereCenter;
    float a = dot(ray, ray);
    float b = 2.0 * dot(toSphere, ray);
    float c = dot(toSphere, toSphere) - sphereRadius * sphereRadius;
    float discriminant = b*b - 4.0*a*c;
    if (discriminant > 0.0) {
      float t = (-b - sqrt(discriminant)) / (2.0 * a);
      if (t > 0.0) return t;
    }
    return 1.0e6;
  }

  vec3 getSphereColor(vec3 point) {
    vec3 color = vec3(0.8, 0.8, 0.9);
    
    // Ambient occlusion with walls
    color *= 1.0 - 0.9 / pow((poolSize / 2.0 + u_sphereRadius - abs(point.x)) / u_sphereRadius, 3.0);
    color *= 1.0 - 0.9 / pow((poolSize / 2.0 + u_sphereRadius - abs(point.z)) / u_sphereRadius, 3.0);
    color *= 1.0 - 0.9 / pow((point.y + poolHeight + u_sphereRadius) / u_sphereRadius, 3.0);

    // Diffuse lighting
    vec3 sphereNormal = normalize(point - u_sphereCenter);
    float diffuse = max(0.0, dot(u_lightDir, sphereNormal));
    color += vec3(1.0) * diffuse * 0.5;

    return color;
  }

  vec3 getWallColor(vec3 point) {
    vec3 wallColor;
    if (point.y < -poolHeight + 0.001) {
        wallColor = texture2D(u_tiles, point.xz * 0.5 + 0.5).rgb;
    } else if (abs(point.x) > (poolSize / 2.0) - 0.001) {
        wallColor = texture2D(u_tiles, point.yz * 0.5 + 0.5).rgb;
    } else {
        wallColor = texture2D(u_tiles, point.zy * 0.5 + 0.5).rgb;
    }
    
    float light_level = 1.0;
    
    return wallColor * light_level;
  }

  vec3 getRefractedColor(vec3 origin, vec3 ray, vec3 waterColor) {
    vec3 color;
    float sphere_t = intersectSphere(origin, ray, u_sphereCenter, u_sphereRadius);
    
    vec3 poolMin = vec3(-poolSize / 2.0, -poolHeight, -poolSize / 2.0);
    vec3 poolMax = vec3(poolSize / 2.0, 10.0, poolSize / 2.0);
    vec2 pool_ts = intersectCube(origin, ray, poolMin, poolMax);

    if (sphere_t < pool_ts.y) {
      color = getSphereColor(origin + ray * sphere_t);
    } else if (ray.y < 0.0) {
      color = getWallColor(origin + ray * pool_ts.y);
    } else {
      color = textureCube(u_skybox, ray).rgb;
      color += vec3(1.0) * pow(max(0.0, dot(u_lightDir, ray)), 2000.0) * 5.0;
    }
    
    if (ray.y < 0.0) color *= waterColor;
    return color;
  }

  void main() {
    vec4 info = texture2D(u_waterTexture, v_uv);
    vec3 normal = normalize(vec3(info.b, sqrt(1.0 - dot(info.ba, info.ba)), info.a));
    vec3 worldNormal = normalize(vec3(normal.x, normal.z, -normal.y));
    
    vec3 incidentRay = normalize(u_cameraPos - v_worldPos);
    
    vec3 refractedRay = refract(-incidentRay, worldNormal, IOR_AIR / IOR_WATER);
    float fresnel = mix(0.25, 1.0, pow(1.0 - dot(worldNormal, incidentRay), 3.0));
    
    vec3 reflectedColor = texture2DProj(u_reflectionTexture, v_reflectionUv).rgb;
    vec3 refractedColor = getRefractedColor(v_worldPos, refractedRay, abovewaterColor);
    
    vec3 color = mix(refractedColor, reflectedColor, fresnel);
    
    gl_FragColor = vec4(color, 1.0);
  }
`;

const createTileTexture = () => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) {
        console.error('Failed to get 2D context for procedural texture');
        return new THREE.Texture();
    }

    const divisions = 4;
    const step = size / divisions;
    const groutWidth = 2;
    
    context.fillStyle = '#b0c4de'; // LightSteelBlue
    context.fillRect(0, 0, size, size);

    for (let y = 0; y < divisions; y++) {
        for (let x = 0; x < divisions; x++) {
            context.fillStyle = '#d8e2f3'; 
            context.fillRect(
                x * step + groutWidth, 
                y * step + groutWidth, 
                step - groutWidth * 2, 
                step - groutWidth * 2
            );
        }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 2);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
};

const WebGLWater = () => {
  const mountRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();

  const waterSimulation = useMemo(() => {
    const SIZE = 256;
    let renderer: THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const plane = new THREE.PlaneGeometry(2, 2);
    const targets = {
      read: new THREE.WebGLRenderTarget(SIZE, SIZE, { type: THREE.FloatType }),
      write: new THREE.WebGLRenderTarget(SIZE, SIZE, { type: THREE.FloatType }),
      swap: function() {
        const temp = this.read;
        this.read = this.write;
        this.write = temp;
      }
    };

    const dropMat = new THREE.ShaderMaterial({
      uniforms: { u_texture: { value: null }, u_center: { value: new THREE.Vector2() }, u_radius: { value: 0.0 }, u_strength: { value: 0.0 } },
      vertexShader: commonVertexShader, fragmentShader: dropShaderFs,
    });
    const updateMat = new THREE.ShaderMaterial({
      uniforms: { u_texture: { value: null }, u_delta: { value: new THREE.Vector2(1 / SIZE, 1 / SIZE) } },
      vertexShader: commonVertexShader, fragmentShader: updateShaderFs,
    });
    const normalMat = new THREE.ShaderMaterial({
      uniforms: { u_texture: { value: null }, u_delta: { value: new THREE.Vector2(1 / SIZE, 1 / SIZE) } },
      vertexShader: commonVertexShader, fragmentShader: normalShaderFs,
    });
    const sphereMat = new THREE.ShaderMaterial({
      uniforms: { u_texture: { value: null }, u_oldCenter: { value: new THREE.Vector3() }, u_newCenter: { value: new THREE.Vector3() }, u_radius: { value: 0.0 } },
      vertexShader: commonVertexShader, fragmentShader: sphereShaderFs,
    });

    const mesh = new THREE.Mesh(plane, updateMat);
    scene.add(mesh);

    return {
      init: (r: THREE.WebGLRenderer) => { renderer = r; },
      addDrop: (x: number, y: number, radius: number, strength: number) => {
        mesh.material = dropMat;
        dropMat.uniforms.u_center.value.set(x, y);
        dropMat.uniforms.u_radius.value = radius;
        dropMat.uniforms.u_strength.value = strength;
        dropMat.uniforms.u_texture.value = targets.read.texture;
        renderer.setRenderTarget(targets.write);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        targets.swap();
      },
      moveSphere: (oldCenter: THREE.Vector3, newCenter: THREE.Vector3, radius: number) => {
        mesh.material = sphereMat;
        sphereMat.uniforms.u_oldCenter.value.copy(oldCenter);
        sphereMat.uniforms.u_newCenter.value.copy(newCenter);
        sphereMat.uniforms.u_radius.value = radius;
        sphereMat.uniforms.u_texture.value = targets.read.texture;
        renderer.setRenderTarget(targets.write);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        targets.swap();
      },
      step: () => {
        mesh.material = updateMat;
        updateMat.uniforms.u_texture.value = targets.read.texture;
        renderer.setRenderTarget(targets.write);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        targets.swap();
      },
      updateNormals: () => {
        mesh.material = normalMat;
        normalMat.uniforms.u_texture.value = targets.read.texture;
        renderer.setRenderTarget(targets.write);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        targets.swap();
      },
      getTexture: () => targets.read.texture,
      dispose: () => {
        targets.read.dispose();
        targets.write.dispose();
        plane.dispose();
      }
    };
  }, []);

  useEffect(() => {
    if (!mountRef.current) return;
    const currentMount = mountRef.current;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, currentMount.clientWidth / currentMount.clientHeight, 0.01, 100);
    camera.position.set(2.5, 2.5, 3.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(currentMount.clientWidth, currentMount.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.localClippingEnabled = true; // For reflection plane
    currentMount.appendChild(renderer.domElement);
    waterSimulation.init(renderer);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    // --- Reflection setup ---
    const reflectionRenderTarget = new THREE.WebGLRenderTarget(512, 512, {
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
    });
    const reflector = new THREE.PerspectiveCamera();
    const reflectorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const textureMatrix = new THREE.Matrix4();
    const reflectorWorldPosition = new THREE.Vector3();
    const cameraWorldPosition = new THREE.Vector3();
    const rotationMatrix = new THREE.Matrix4();
    const lookAtPosition = new THREE.Vector3(0, 0, -1);
    const clipPlane = new THREE.Vector4();
    const view = new THREE.Vector3();
    const target = new THREE.Vector3();
    const q = new THREE.Quaternion();

    // --- Sky and Environment Map Setup ---
    const sky = new Sky();
    sky.scale.setScalar(100.0);
    const skyUniforms = sky.material.uniforms;
    skyUniforms['turbidity'].value = 10;
    skyUniforms['rayleigh'].value = 2;
    skyUniforms['mieCoefficient'].value = 0.005;
    skyUniforms['mieDirectionalG'].value = 0.8;

    const sunPosition = new THREE.Vector3(1, 1, -1).normalize();
    skyUniforms['sunPosition'].value.copy(sunPosition);

    // Generate cubemap from sky
    const cubeRenderTarget = new THREE.WebGLCubeRenderTarget(512);
    const cubeCamera = new THREE.CubeCamera(0.1, 1000, cubeRenderTarget);
    const skyScene = new THREE.Scene();
    skyScene.add(sky);
    cubeCamera.update(renderer, skyScene);
    const textureCube = cubeRenderTarget.texture;
    
    scene.background = textureCube;

    const tilesTexture = createTileTexture();
    
    const waterGeo = new THREE.PlaneGeometry(2, 2, 256, 256);
    const waterMaterial = new THREE.ShaderMaterial({
        uniforms: { 
            u_waterTexture: { value: null }, 
            u_reflectionTexture: { value: reflectionRenderTarget.texture },
            u_textureMatrix: { value: textureMatrix },
            u_tiles: { value: tilesTexture },
            u_skybox: { value: textureCube }, 
            u_lightDir: { value: sunPosition }, 
            u_cameraPos: { value: camera.position },
            u_sphereCenter: { value: new THREE.Vector3() },
            u_sphereRadius: { value: 0.0 }
        },
        vertexShader: waterVertexShader, 
        fragmentShader: waterFragmentShader,
    });

    // --- Add lights to the scene ---
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
    directionalLight.position.copy(sunPosition);
    scene.add(directionalLight);

    const poolSize = 2;
    // The pool material needs to render the BACK side of the faces to be visible from the inside.
    const poolMaterial = new THREE.MeshStandardMaterial({
      map: tilesTexture,
      envMap: textureCube,
      roughness: 0.1,
      metalness: 0.1,
      side: THREE.BackSide // Render the inside of the box
    });

    const poolGeo = new THREE.BoxGeometry(poolSize, 1, poolSize);

    // Use an array of materials to make the top face invisible.
    // The order is: right, left, top, bottom, front, back
    const poolMesh = new THREE.Mesh(poolGeo, [
      poolMaterial, // right
      poolMaterial, // left
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide }), // top (invisible)
      poolMaterial, // bottom
      poolMaterial, // front
      poolMaterial  // back
    ]);
    poolMesh.position.y = -0.5;
    // The negative scale is no longer needed because THREE.BackSide handles the normal inversion for rendering.
    scene.add(poolMesh);

    const waterMesh = new THREE.Mesh(waterGeo, waterMaterial);
    waterMesh.rotation.x = -Math.PI / 2;
    scene.add(waterMesh);

    const sphereRadius = 0.25;
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(sphereRadius, 32, 32),
      new THREE.MeshStandardMaterial({ 
        color: 0xffffff, 
        envMap: textureCube, 
        roughness: 0.05, 
        metalness: 0.95 
      })
    );
    sphere.position.set(-0.3, -0.1, 0.3);
    scene.add(sphere);
    waterMaterial.uniforms.u_sphereRadius.value = sphereRadius;
    let oldSpherePos = sphere.position.clone();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let isDraggingSphere = false;
    let isDraggingWater = false;
    const dragPlane = new THREE.Plane();
    const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const onPointerDown = (e: PointerEvent) => {
      pointer.x = (e.clientX / currentMount.clientWidth) * 2 - 1;
      pointer.y = -(e.clientY / currentMount.clientHeight) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const intersects = raycaster.intersectObject(sphere);
      if (intersects.length > 0) {
        isDraggingSphere = true;
        controls.enabled = false;
        dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), intersects[0].point);
      } else {
        isDraggingWater = true;
        onPointerMove(e);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDraggingSphere && !isDraggingWater) return;
      pointer.x = (e.clientX / currentMount.clientWidth) * 2 - 1;
      pointer.y = -(e.clientY / currentMount.clientHeight) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      if (isDraggingSphere) {
        const point = new THREE.Vector3();
        raycaster.ray.intersectPlane(dragPlane, point);
        sphere.position.copy(point);
        const limit = poolSize / 2 - sphereRadius;
        sphere.position.x = Math.max(-limit, Math.min(limit, sphere.position.x));
        sphere.position.z = Math.max(-limit, Math.min(limit, sphere.position.z));
        sphere.position.y = Math.max(-0.5 + sphereRadius, Math.min(0.5, sphere.position.y));
      } else if (isDraggingWater) {
        const point = new THREE.Vector3();
        raycaster.ray.intersectPlane(waterPlane, point);
        const uvX = point.x / poolSize + 0.5;
        const uvY = 0.5 - point.z / poolSize;
        if (uvX >= 0 && uvX <= 1 && uvY >= 0 && uvY <= 1) {
          waterSimulation.addDrop(uvX, uvY, 0.03, 0.02);
        }
      }
    };

    const onPointerUp = () => { 
      isDraggingSphere = false; 
      isDraggingWater = false; 
      controls.enabled = true; 
    };

    currentMount.addEventListener('pointerdown', onPointerDown);
    currentMount.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    const updateReflector = () => {
        reflectorWorldPosition.setFromMatrixPosition(waterMesh.matrixWorld);
        cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
        rotationMatrix.extractRotation(waterMesh.matrixWorld);
        
        const normal = new THREE.Vector3(0, 1, 0); // Water plane normal
        normal.applyMatrix4(rotationMatrix);

        view.subVectors(reflectorWorldPosition, cameraWorldPosition);
        view.reflect(normal).negate();
        view.add(reflectorWorldPosition);

        rotationMatrix.extractRotation(camera.matrixWorld);
        lookAtPosition.set(0, 0, -1);
        lookAtPosition.applyMatrix4(rotationMatrix);
        lookAtPosition.add(cameraWorldPosition);

        target.subVectors(reflectorWorldPosition, lookAtPosition);
        target.reflect(normal).negate();
        target.add(reflectorWorldPosition);

        reflector.position.copy(view);
        reflector.up.set(0, 1, 0);
        reflector.up.applyMatrix4(rotationMatrix);
        reflector.up.reflect(normal);
        reflector.lookAt(target);

        reflector.far = camera.far;
        reflector.near = camera.near;
        reflector.aspect = camera.aspect;
        reflector.fov = camera.fov;
        reflector.updateProjectionMatrix();
        
        textureMatrix.set(
            0.5, 0.0, 0.0, 0.5,
            0.0, 0.5, 0.0, 0.5,
            0.0, 0.0, 0.5, 0.5,
            0.0, 0.0, 0.0, 1.0
        );
        textureMatrix.multiply(reflector.projectionMatrix);
        textureMatrix.multiply(reflector.matrixWorldInverse);
    };

    const animate = () => {
      controls.update();
      if (oldSpherePos.distanceTo(sphere.position) > 0.001) {
        waterSimulation.moveSphere(
          new THREE.Vector3(oldSpherePos.x, oldSpherePos.y, -oldSpherePos.z),
          new THREE.Vector3(sphere.position.x, sphere.position.y, -sphere.position.z),
          sphereRadius
        );
        oldSpherePos.copy(sphere.position);
      }
      waterSimulation.step();
      waterSimulation.updateNormals();
      
      // Reflection Pass
      waterMesh.visible = false;
      poolMaterial.side = THREE.FrontSide; // Render exterior for reflection
      updateReflector();
      renderer.clippingPlanes = [reflectorPlane];
      renderer.setRenderTarget(reflectionRenderTarget);
      renderer.render(scene, reflector);
      renderer.setRenderTarget(null);
      renderer.clippingPlanes = [];
      poolMaterial.side = THREE.BackSide; // Render interior for main render
      waterMesh.visible = true;

      // Main Render Pass
      waterMaterial.uniforms.u_waterTexture.value = waterSimulation.getTexture();
      waterMaterial.uniforms.u_cameraPos.value.copy(camera.position);
      waterMaterial.uniforms.u_sphereCenter.value.copy(sphere.position);
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    const animId = requestAnimationFrame(animate);

    return () => {
      currentMount.removeEventListener('pointerdown', onPointerDown);
      currentMount.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      cancelAnimationFrame(animId);
      waterSimulation.dispose();
      reflectionRenderTarget.dispose();
      renderer.dispose();
      currentMount.removeChild(renderer.domElement);
    };
  }, [waterSimulation]);

  return <div ref={mountRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }} />;
};

export default WebGLWater;