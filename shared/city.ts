import type { Obstacle, Pose } from './types';
import cityData from './city-data.json';
import { BATTLEFIELD } from './battlefield';

// Renderer and simulator data only. Never expose this module through drone tools.
export interface CityPoint { x: number; z: number }
export interface CityRoad { name: string; points: CityPoint[]; width: number }
export interface CityPark { name: string; points: CityPoint[]; color?: string }
export interface CityIntersection extends CityPoint { id: string; streets: string[] }
export interface CityWorld {
  name: string; sourceNote: string;
  bounds: { x: [number, number]; y: [number, number]; z: [number, number] };
  spawns: Pose[]; buildings: Obstacle[]; roads: CityRoad[]; parks: CityPark[];
  river: CityPoint[]; riverHoles: CityPoint[][]; cityBoundary: CityPoint[][]; intersections: CityIntersection[];
}

// Rebuild with node scripts/build-city.mjs; geographic sources stay out of the model runtime.
export const CITY = { ...cityData, spawns: Object.values(BATTLEFIELD.spawns) } as CityWorld;
