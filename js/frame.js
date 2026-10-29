// Anatomical frame of the brain mesh, shared by the direction picture and the cut planes.
// The mesh is stored at an angle, so its own x/y/z axes are not the head's axes. The long (front-back) axis is the first
// principal component of the vertices; "up" is the data z axis made perpendicular to it.
import * as THREE from "three";

export const AP = new THREE.Vector3(0.5666831, 0.8093131, -0.1545399); // front-back axis (the picture's X, toward the viewer)
export const UP = new THREE.Vector3(0, 0, 1).addScaledVector(AP, -AP.z).normalize(); // vertical axis (Z)
export const RIGHT = UP.clone().cross(AP); // left-right axis (Y, to the viewer's right)
export const AXES = { x: AP, y: RIGHT, z: UP };
