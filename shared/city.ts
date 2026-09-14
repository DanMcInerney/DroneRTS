import type { Obstacle, Pose, Treasure } from './types';
import cityData from './city-data.json';

// Renderer and simulator data only. Never expose this module through drone tools.
export interface CityPoint { x: number; z: number }
export interface CityRoad { name: string; points: CityPoint[]; width: number }
export interface CityPark { name: string; points: CityPoint[]; color?: string }
export interface CityWorld {
  name: string; sourceNote: string;
  bounds: { x: [number, number]; y: [number, number]; z: [number, number] };
  spawns: Pose[]; buildings: Obstacle[]; roads: CityRoad[]; parks: CityPark[];
  river: CityPoint[]; treasures: Treasure[];
}

// Rebuild with node scripts/build-city.mjs; geographic sources stay out of the model runtime.
export const CITY = cityData as CityWorld;
