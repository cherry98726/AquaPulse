@echo off
set "INFERENCE_EXE=%LOCALAPPDATA%\RoboflowInference\inference.exe"

if not exist "%INFERENCE_EXE%" (
  echo Roboflow Inference is not installed at:
  echo %INFERENCE_EXE%
  exit /b 1
)

start "Roboflow Inference Server" "%INFERENCE_EXE%"
echo Roboflow Inference Server is starting on http://127.0.0.1:9001
