"""HTTP adapter for bounded local PS3 jobs and read-only investigation."""
from __future__ import annotations

from pathlib import Path
import shutil
from typing import Annotated, Literal
import uuid

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.concurrency import run_in_threadpool

from backend.ps3.assistant import investigate
from backend.ps3.project_tools import ProjectTools
from backend.ps3.service import PS3Service, safe_filename
from backend.ps3.summary import ResultSummarizer


class ExampleRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    all_files: bool = False


class ExportSelection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    job_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    file_ids: list[Annotated[str, Field(min_length=1, max_length=150)]] = Field(min_length=1, max_length=100)

    @model_validator(mode='after')
    def distinct_files(self):
        if any(not name.strip() for name in self.file_ids) or len({name.casefold() for name in self.file_ids}) != len(self.file_ids):
            raise ValueError('Choose distinct, nonempty source filenames for each selected run.')
        return self


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    job_ids: list[str] | None = Field(default=None, min_length=1, max_length=100)
    selections: list[ExportSelection] | None = Field(default=None, min_length=1, max_length=16)

    @model_validator(mode='after')
    def one_selection_mode(self):
        if len(self.model_fields_set & {'job_ids', 'selections'}) != 1 or (self.job_ids is None and self.selections is None):
            raise ValueError('Provide either complete job IDs or explicit file selections, never both.')
        if self.selections is not None and len({selection.job_id for selection in self.selections}) != len(self.selections):
            raise ValueError('Each selected run must appear only once.')
        return self


class InvestigationMessage(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    role: Literal['user', 'assistant']
    content: str = Field(min_length=1, max_length=12000)


class InvestigationRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    job_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{32}$')
    file_id: str | None = Field(default=None, min_length=1, max_length=150)
    question: str = Field(min_length=3, max_length=4000)
    scope: Literal['file', 'run', 'project'] = 'file'
    history: list[InvestigationMessage] = Field(default_factory=list, max_length=12)

    @model_validator(mode='after')
    def valid_context(self):
        if self.scope in {'file', 'run'} and not self.job_id:
            raise ValueError('Select a completed run, or use Project scope.')
        if (self.scope == 'file' and not self.file_id) or (self.file_id and not self.job_id):
            raise ValueError('A source recording requires its completed run.')
        if sum(len(message.content) for message in self.history) > 40000:
            raise ValueError('Conversation context is too long. Start a new investigation.')
        return self


class SummaryRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    job_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    scope: Literal['file', 'run'] = 'file'
    file_id: str | None = Field(default=None, min_length=1, max_length=150)

    @model_validator(mode='after')
    def valid_scope(self):
        if self.scope == 'file' and not self.file_id:
            raise ValueError('Choose a source recording for a file summary.')
        if self.scope == 'run' and self.file_id is not None:
            raise ValueError('An all-files summary cannot select an individual recording.')
        return self


def router(service: PS3Service):
    routes = APIRouter(prefix='/api/ps3', tags=['PS3 released data'])
    summarizer = ResultSummarizer()

    @routes.get('/status')
    def status():
        return service.status()

    @routes.get('/jobs')
    def jobs(limit: int = Query(40, ge=1, le=100),
             subsystem: Literal['door', 'acv', 'rail', 'shm'] | None = None):
        return service.list_jobs(limit=limit, subsystem=subsystem)

    @routes.post('/jobs', status_code=202)
    async def upload(subsystem: str = Form(...), files: list[UploadFile] = File(...)):
        inputs = None
        submitted = False
        try:
            spec = service.spec(subsystem)
            if not service.model(subsystem):
                raise HTTPException(409, 'The subsystem model is not trained yet.')
            if not 1 <= len(files) <= 100 or (subsystem == 'door' and len(files) != 1):
                raise ValueError('Choose one Door stream, or up to 100 files for another subsystem.')
            names = [safe_filename(f.filename or '', spec['extension']) for f in files]
            if len({n.casefold() for n in names}) != len(names):
                raise ValueError('Each uploaded source must have a distinct filename.')
            job_id = uuid.uuid4().hex
            inputs = service.jobs_dir / job_id / 'inputs'
            inputs.mkdir(parents=True)
            paths, total = [], 0
            for upload_file, name in zip(files, names):
                path = inputs / name
                size = 0
                with path.open('wb') as target:
                    while chunk := await upload_file.read(1024**2):
                        size += len(chunk)
                        total += len(chunk)
                        if size > 64 * 1024**2 or total > 1500 * 1024**2:
                            raise HTTPException(413, 'Limits are 64 MiB per file and 1,500 MiB per batch. No partial predictions were created.')
                        target.write(chunk)
                if size == 0:
                    raise ValueError(f'{name} is empty.')
                paths.append(path)
            result = service.create(subsystem, paths, 'uploaded', job_id)
            submitted = True
            return result
        finally:
            for f in files:
                await f.close()
            if inputs is not None and not submitted:
                # The directory is generated internally and checked inside the job root.
                resolved = inputs.parent.resolve()
                if resolved.parent == service.jobs_dir.resolve():
                    shutil.rmtree(resolved)

    @routes.post('/examples/{subsystem}', status_code=202)
    def examples(subsystem: str, body: ExampleRequest):
        return service.example_job(subsystem, body.all_files)

    @routes.get('/jobs/{job_id}')
    def job(job_id: str):
        return service.get(job_id)

    @routes.get('/jobs/{job_id}/csv')
    def csv(job_id: str, file_id: str | None = Query(None, min_length=1, max_length=150)):
        raw, name = service.csv(job_id, file_id=file_id)
        return Response(raw, media_type='text/csv', headers={'Content-Disposition': f'attachment; filename="{name}"'})

    @routes.post('/export')
    def export(body: ExportRequest):
        selections = [selection.model_dump() for selection in body.selections] if body.selections is not None else None
        return Response(service.bundle(body.job_ids, selections=selections), media_type='application/zip', headers={'Content-Disposition': 'attachment; filename="predictions.zip"'})

    @routes.post('/investigate')
    async def investigation(body: InvestigationRequest):
        report, validation = None, {}
        if body.job_id:
            job = service.get(body.job_id)
            if job['status'] != 'completed':
                raise ValueError('Select a completed prediction before starting an investigation.')
            validation = job.get('validation') or {}
            if body.file_id:
                report = next((r for r in job['reports'] if r['file_id'] == body.file_id), None)
                if report is None:
                    raise KeyError('The selected file is not part of this job.')
        project = ProjectTools(service, scope=body.scope, job_id=body.job_id, file_id=body.file_id)
        return await run_in_threadpool(investigate, report, validation, body.question,
                                       project_tools=project, history=[message.model_dump() for message in body.history])

    @routes.post('/summary')
    async def summary(body: SummaryRequest):
        job = await run_in_threadpool(service.get, body.job_id)
        if job.get('status') != 'completed':
            raise HTTPException(409, 'Select a completed prediction before requesting a result summary.')
        reports = job.get('reports')
        if body.scope == 'run':
            return await summarizer.summarize_run(reports, job.get('subsystem'), job.get('model_sha256'))
        matches = [item for item in reports if isinstance(item, dict) and item.get('file_id') == body.file_id] if isinstance(reports, list) else []
        if not matches:
            raise HTTPException(404, 'The selected file is not part of this completed job.')
        if len(matches) != 1:
            raise HTTPException(409, 'The selected file has ambiguous saved predictions. Analyse the recording again.')
        return await summarizer.summarize(matches[0], job.get('subsystem'), job.get('model_sha256'))

    return routes
