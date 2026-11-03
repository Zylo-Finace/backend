import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export enum SortDirection {
  Asc = 'asc',
  Desc = 'desc',
}

/**
 * Offset pagination.
 *
 * Convenient for admin UIs that need "page 7 of 40", but `OFFSET n` makes Postgres
 * walk and discard `n` rows — cost grows linearly with depth. Capped page size plus
 * an upper bound on `page` keeps the worst case bounded; anything that scans deep
 * (exports, campaign audiences) must use {@link CursorPaginationQueryDto} instead.
 */
export class OffsetPaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000, { message: 'Deep offset paging is not supported; use cursor pagination' })
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  @IsOptional()
  limit: number = DEFAULT_PAGE_SIZE;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }

  get take(): number {
    return this.limit;
  }
}

/**
 * Cursor (keyset) pagination — the default for anything tenant-scoped and large.
 *
 * Constant-time regardless of depth and stable under concurrent inserts, which
 * offset paging is not: inserting a row shifts every later page by one and makes
 * clients silently skip records.
 */
export class CursorPaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Opaque cursor from the previous page. Do not construct by hand.',
  })
  @IsString()
  @MaxLength(512)
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  @IsOptional()
  limit: number = DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({ enum: SortDirection, default: SortDirection.Desc })
  @IsEnum(SortDirection)
  @IsOptional()
  direction: SortDirection = SortDirection.Desc;
}

/** Common `?search=` / `?sort=` surface shared by list endpoints. */
export class SearchQueryDto {
  @ApiPropertyOptional({ description: 'Full-text search term.' })
  @IsString()
  @MaxLength(256)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : undefined,
  )
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ description: 'Field to sort by. Allowed values are per-endpoint.' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  sortBy?: string;

  @ApiPropertyOptional({ enum: SortDirection, default: SortDirection.Desc })
  @IsEnum(SortDirection)
  @IsOptional()
  sortDirection: SortDirection = SortDirection.Desc;
}

export class OffsetPageMeta {
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty() hasNextPage!: boolean;
  @ApiProperty() hasPreviousPage!: boolean;
}

export class CursorPageMeta {
  @ApiProperty() limit!: number;
  @ApiProperty() hasNextPage!: boolean;
  @ApiPropertyOptional({ description: 'Pass as `cursor` to fetch the next page.' })
  nextCursor?: string;
}

export interface OffsetPage<T> {
  items: T[];
  meta: OffsetPageMeta;
}

export interface CursorPage<T> {
  items: T[];
  meta: CursorPageMeta;
}

export function buildOffsetPage<T>(
  items: T[],
  total: number,
  query: Pick<OffsetPaginationQueryDto, 'page' | 'limit'>,
): OffsetPage<T> {
  const totalPages = query.limit > 0 ? Math.ceil(total / query.limit) : 0;
  return {
    items,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPreviousPage: query.page > 1,
    },
  };
}

/**
 * Builds a cursor page from a slice fetched with `take: limit + 1`.
 *
 * Over-fetching one row is how we learn `hasNextPage` without a second COUNT query.
 */
export function buildCursorPage<T>(
  rows: T[],
  limit: number,
  toCursor: (item: T) => string,
): CursorPage<T> {
  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    meta: {
      limit,
      hasNextPage,
      nextCursor: hasNextPage && last !== undefined ? toCursor(last) : undefined,
    },
  };
}
