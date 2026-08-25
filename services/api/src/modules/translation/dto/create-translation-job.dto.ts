import { IsUUID, IsNotEmpty, IsString, IsOptional, IsIn } from 'class-validator';

export class CreateTranslationJobDto {
  @IsUUID(undefined, { message: 'chapterVersionId phải là UUID hợp lệ' })
  @IsNotEmpty({ message: 'chapterVersionId không được để trống' })
  chapterVersionId: string;

  @IsString()
  @IsNotEmpty()
  sourceLang: string;

  @IsString()
  @IsNotEmpty()
  targetLang: string;

  @IsOptional()
  @IsString()
  @IsIn(['OPENAI', 'DEEPL', 'LOCAL_LLM', 'GEMINI', 'CLAUDE'], {
    message:
      'Provider phải thuộc danh sách hợp lệ (OPENAI, DEEPL, LOCAL_LLM, GEMINI, CLAUDE)',
  })
  provider?: string;
}
