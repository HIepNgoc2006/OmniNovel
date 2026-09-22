import 'package:flutter/material.dart';
import 'app/app.dart';
import 'app/bootstrap.dart';

void main() async {
  final bootstrapResult = await AppBootstrap.run();
  runApp(OmniNovelApp(bootstrapResult: bootstrapResult));
}
