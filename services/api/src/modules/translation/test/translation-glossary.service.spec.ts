import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { TranslationService } from '../translation.service';
import { TranslationJob } from '../entities/translation-job.entity';
import { TranslationProject } from '../entities/translation-project.entity';
import { TranslationGlossary } from '../entities/translation-glossary.entity';
import { TranslationSegment } from '../entities/translation-segment.entity';
import { ChapterVersion } from '../../chapters/entities/chapter-version.entity';
import { Chapter } from '../../chapters/entities/chapter.entity';
import { MediaAsset } from '../../chapters/entities/media-asset.entity';
import { UploadSession } from '../../storage/entities/upload-session.entity';
import { StoryMember } from '../../stories/entities/story-member.entity';
import { StorageService } from '../../storage/storage.service';
import { TranslationGateway } from '../translation.gateway';
import { TranslationProcessor } from '../translation.processor';
import { ChapterArtifact } from '../../chapters/entities/chapter-artifact.entity';
import { CanonicalPackagingService } from '../../chapters/canonical-packaging.service';

describe('TranslationService - Glossary Operations (#189)', () => {
  let service: TranslationService;
  let mockProjectRepo: any;
  let mockGlossaryRepo: any;

  const validProjectId = '11111111-1111-4111-8111-111111111111';
  const mockUser = { id: 'user-1', role: 'ADMIN' };

  beforeEach(async () => {
    mockProjectRepo = {
      findOne: jest.fn(),
    };
    mockGlossaryRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((data) => ({ ...data, id: 'glossary-1', createdAt: new Date().toISOString() })),
      save: jest.fn(async (entity) => entity),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranslationService,
        { provide: getRepositoryToken(TranslationJob), useValue: {} },
        { provide: getRepositoryToken(TranslationProject), useValue: mockProjectRepo },
        { provide: getRepositoryToken(TranslationGlossary), useValue: mockGlossaryRepo },
        { provide: getRepositoryToken(TranslationSegment), useValue: {} },
        { provide: getRepositoryToken(ChapterVersion), useValue: {} },
        { provide: getRepositoryToken(Chapter), useValue: {} },
        { provide: getRepositoryToken(MediaAsset), useValue: {} },
        { provide: getRepositoryToken(UploadSession), useValue: {} },
        { provide: getRepositoryToken(ChapterArtifact), useValue: {} },
        { provide: getRepositoryToken(StoryMember), useValue: {} },
        { provide: 'BullQueue_translation', useValue: {} },
        { provide: 'BullQueue_translation-materialization', useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: CanonicalPackagingService, useValue: {} },
        { provide: DataSource, useValue: {} },
        { provide: TranslationGateway, useValue: {} },
        { provide: TranslationProcessor, useValue: {} },
      ],
    }).compile();

    service = module.get<TranslationService>(TranslationService);
  });

  describe('createGlossary', () => {
    it('normalizes whitespace and upserts canonical term (" Hero " -> "Hero")', async () => {
      mockProjectRepo.findOne.mockResolvedValue({
        id: validProjectId,
        storyEdition: { story: { id: 'story-1' } },
      });
      mockGlossaryRepo.findOne.mockResolvedValue(null);

      const result = await service.createGlossary(mockUser, {
        projectId: validProjectId,
        sourceTerm: '  Hero  ',
        targetTerm: '  Anh hùng  ',
        category: '  CHARACTER_NAME  ',
      });

      expect(mockGlossaryRepo.findOne).toHaveBeenCalledWith({
        where: { projectId: validProjectId, sourceTerm: 'Hero' },
      });
      expect(mockGlossaryRepo.create).toHaveBeenCalledWith({
        projectId: validProjectId,
        sourceTerm: 'Hero',
        targetTerm: 'Anh hùng',
        category: 'CHARACTER_NAME',
      });
      expect(result.sourceTerm).toBe('Hero');
      expect(result.targetTerm).toBe('Anh hùng');
    });

    it('updates existing term when canonical sourceTerm matches exactly', async () => {
      const existing = {
        id: 'glossary-existing',
        projectId: validProjectId,
        sourceTerm: 'Hero',
        targetTerm: 'Dũng sĩ',
        category: 'CHARACTER_NAME',
      };

      mockProjectRepo.findOne.mockResolvedValue({
        id: validProjectId,
        storyEdition: { story: { id: 'story-1' } },
      });
      mockGlossaryRepo.findOne.mockResolvedValue(existing);

      const result = await service.createGlossary(mockUser, {
        projectId: validProjectId,
        sourceTerm: ' Hero ',
        targetTerm: ' Anh hùng ',
      });

      expect(mockGlossaryRepo.findOne).toHaveBeenCalledWith({
        where: { projectId: validProjectId, sourceTerm: 'Hero' },
      });
      expect(existing.targetTerm).toBe('Anh hùng');
      expect(mockGlossaryRepo.save).toHaveBeenCalledWith(existing);
      expect(result.targetTerm).toBe('Anh hùng');
    });

    it('throws BadRequestException if sourceTerm or targetTerm is empty after trim', async () => {
      mockProjectRepo.findOne.mockResolvedValue({
        id: validProjectId,
        storyEdition: { story: { id: 'story-1' } },
      });

      await expect(
        service.createGlossary(mockUser, {
          projectId: validProjectId,
          sourceTerm: '   ',
          targetTerm: 'Valid Target',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException if project does not exist', async () => {
      mockProjectRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createGlossary(mockUser, {
          projectId: validProjectId,
          sourceTerm: 'Hero',
          targetTerm: 'Anh hùng',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getGlossaries', () => {
    it('returns terms ordered by createdAt ASC', async () => {
      mockProjectRepo.findOne.mockResolvedValue({
        id: validProjectId,
        storyEdition: { story: { id: 'story-1' } },
      });
      const terms = [
        { id: '1', sourceTerm: 'A', targetTerm: 'B', createdAt: '2026-01-01' },
        { id: '2', sourceTerm: 'C', targetTerm: 'D', createdAt: '2026-01-02' },
      ];
      mockGlossaryRepo.find.mockResolvedValue(terms);

      const result = await service.getGlossaries(validProjectId, mockUser);
      expect(mockGlossaryRepo.find).toHaveBeenCalledWith({
        where: { projectId: validProjectId },
        order: { createdAt: 'ASC' },
      });
      expect(result).toEqual(terms);
    });
  });
});
