FROM python:3.12-alpine

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server ./server
COPY studio ./studio
# The tablet renderer, copied in from the repo's web/ folder by package-addon.ps1 before the image is built.
COPY renderer ./renderer

ENV PYTHONUNBUFFERED=1
CMD ["python", "-m", "server"]
