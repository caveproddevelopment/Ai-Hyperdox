const BASE_URL = import.meta.env.VITE_API_URL;

export const generateGoalsAndScope = async (formData) => {
  const response = await fetch(`${BASE_URL}/api/goals-scope/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formData)
  });
  return response.json();
};

export const getLastRun = async (projectId, docType) => {
  const response = await fetch(`${BASE_URL}/api/runs/${projectId}/${docType}`);
  return response.json();
};