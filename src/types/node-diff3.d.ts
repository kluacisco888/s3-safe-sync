declare module "node-diff3" {
  export function diffIndices<T>(a: T[], b: T[]): Array<{
    buffer1: [number, number];
    buffer2: [number, number];
  }>;

  export interface MergeRegion<T> {
    conflict?: {
      a: T[];
      b: T[];
      o: T[];
    };
    ok?: T[];
  }

  export function diff3Merge<T = string>(
    changedA: string | T[],
    original: string | T[],
    changedB: string | T[],
    options?: { excludeFalseConflicts?: boolean },
  ): MergeRegion<T>[];
}
