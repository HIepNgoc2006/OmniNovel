import { IsInt, IsNotEmpty, IsString, Matches, Min } from 'class-validator';

export class RequestStructureSnapshotUploadDto {
  @IsInt()
  @Min(1)
  attemptNumber: number;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-f0-9]{64}$/, {
    message: 'sha256 must be a 64-character lowercase hex string',
  })
  sha256: string;
}
