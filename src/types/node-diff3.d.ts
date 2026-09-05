declare module "node-diff3" {
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
