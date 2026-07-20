from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.core.dependencies import get_current_user
from app.routers import writing, tone, memory, migration, billing, profile

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    docs_url="/docs",
    redoc_url="/redoc",
)

default_origins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:8000",
]
configured_origins = [
    origin.strip()
    for origin in settings.CORS_ORIGINS.split(",")
    if origin.strip()
]
allow_origins = configured_origins or default_origins

# CORS config to allow Chrome extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_origin_regex=r"^chrome-extension://[a-z]{32}$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(writing.router, prefix="/write", tags=["Writing"])
app.include_router(tone.router, prefix="/tone", tags=["Tone"])
app.include_router(memory.router, prefix="/memory", tags=["Memory"])
app.include_router(migration.router, prefix="/migration", tags=["Migration"])
app.include_router(billing.router, prefix="/billing", tags=["Billing"])
app.include_router(profile.router, prefix="/profile", tags=["Profile"])


@app.get("/")
def health_check():
    return {"status": "ok", "app": settings.PROJECT_NAME, "version": settings.VERSION}


@app.get("/me")
async def get_me(
    user=Depends(get_current_user),
):
    """Authenticated endpoint to check the current backend session."""
    return {"id": str(user.id), "email": user.email}
