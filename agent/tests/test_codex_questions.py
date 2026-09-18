import importlib.util,sys,unittest,json,io
from unittest.mock import patch
sys.path.insert(0,'agent/hooks')
spec=importlib.util.spec_from_file_location('reporter','agent/hooks/codex-reporter.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Questions(unittest.TestCase):
 def test_all_question_tools_and_shapes(self):
  for tool in ('request_user_input','request_user_input_async'):
   for value in ({'questions':[{'id':'model','question':'Model?','options':[{'label':'Qwen','description':'Large'}]},{'id':'criteria','question':'Criteria?'}]}, {'questions':[{'title':'Model?','options':['Qwen','Other model']},{'title':'Criteria?'}]}):
    with self.subTest(tool=tool,value=value):
     got=m.question_request({'tool_name':tool,'tool_input':value,'tool_use_id':'call-1'})
     self.assertEqual(got['toolName'],tool)
     self.assertEqual(len(got['toolInput']['questions']),2)
     self.assertEqual(got['toolInput']['questions'][0]['question'],'Model?')
     self.assertEqual(got['toolInput']['questions'][0]['options'][0]['label'],'Qwen')
     self.assertNotIn('options',got['toolInput']['questions'][1])
 def test_reporter_publishes_each_form_without_polling(self):
  for tool in m.QUESTION_TOOLS:
   payload={'session_id':'question-test-session','cwd':'/tmp','hook_event_name':'PostToolUse','tool_name':tool,'tool_input':{'questions':[{'title':'Which model?','options':['Qwen']}]},'tool_use_id':tool}
   calls=[]
   with patch.object(sys,'stdin',io.StringIO(json.dumps(payload))), patch.object(m,'post_json',side_effect=lambda url,body: calls.append((url,json.loads(body))) or True), patch.object(m,'reserve_seqs',return_value=1):
    m.main()
   forms=[body for url,body in calls if url.endswith('/api/permissions/request')]
   self.assertEqual(len(forms),1)
   self.assertEqual(forms[0]['sessionId'],'question-test-session')
   self.assertEqual(forms[0]['toolInput']['questions'][0]['question'],'Which model?')
 def test_other_tools(self):
  self.assertIsNone(m.question_request({'tool_name':'Bash'}))
unittest.main()
